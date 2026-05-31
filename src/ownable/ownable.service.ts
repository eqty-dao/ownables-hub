import { Injectable, OnModuleInit, StreamableFile } from '@nestjs/common';
import { calculateOwnablePackageCid, evaluateReplayFreshness, publicEventReplayKey } from '@ownables/core';
import { ConfigService, RuntimeNetworkProfile } from '../common/config/config.service.js';
import { CosmWasmService } from '../cosmwasm/cosmwasm.service.js';
import Contract from '../cosmwasm/contract.js';
import { NFTInfo } from '../interfaces/OwnableInfo.js';
import { NFTService } from '../nft/nft.service.js';
import { AuthError, UserError } from '../interfaces/error.js';
import JSZip from 'jszip';
import { Event, EventChain } from 'eqty-core';
import { Readable } from 'stream';
import { ArchiveStorageService } from '../storage/archive-storage.service.js';
import { HubStateRepository, IndexedWalletEvent } from '../persistence/repos/hub-state.repository.js';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

interface SignerIdentity {
  address?: string;
}

interface ReplayDerivedState {
  nftInfo: NFTInfo;
  owner: string;
  latestAppliedPublicEventId: string | null;
}

@Injectable()
export class OwnableService implements OnModuleInit {
  constructor(
    private config: ConfigService,
    private cosmWasm: CosmWasmService,
    private nft: NFTService,
    private readonly storage: ArchiveStorageService,
    private readonly hubState: HubStateRepository,
  ) {
    const mnemonic = this.config.getAuthoritySignerMnemonic();
    if (!mnemonic) {
      throw new Error('Missing account mnemonic configuration');
    }
  }

  async onModuleInit() {}

  public async GetServerETHBalance(networkName: string): Promise<string> {
    return await this.nft.GetServerETHBalance(networkName);
  }

  private async applyEvent(contract: Contract, event: Event): Promise<void> {
    const info: { sender: string; funds: [] } = { sender: event.signerAddress ?? '', funds: [] };
    const { '@context': context, ...msg } = event.parsedData;

    switch (context) {
      case 'instantiate_msg.json':
        await contract.instantiate(msg, info);
        break;
      case 'execute_msg.json':
        await contract.execute(msg, info);
        break;
      case 'external_event_msg.json':
        await contract.externalEvent(msg, info);
        break;
      default:
        throw new UserError(`Unknown event type: ${context}`);
    }
  }

  private async loadContractFromFiles(files: Map<string, Buffer>): Promise<Contract> {
    const js = files.get('ownable.js');
    const wasm = files.get('ownable_bg.wasm');
    if (!js || !wasm) {
      throw new UserError('Invalid package: ownable runtime assets missing');
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-ownable-'));
    const jsFile = path.join(tmpDir, 'ownable.js');
    const wasmFile = path.join(tmpDir, 'ownable_bg.wasm');

    await fs.writeFile(jsFile, js);
    await fs.writeFile(wasmFile, wasm);

    try {
      return await this.cosmWasm.load(jsFile, wasmFile);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private toReplayEvent(row: IndexedWalletEvent): Event | null {
    if (row.eventKind !== 'public' || !row.sourceAddress || !row.eventType || !row.dataHex) {
      return null;
    }

    return new Event({
      '@context': 'external_event_msg.json',
      source: row.sourceAddress,
      eventType: row.eventType,
      data: row.dataHex,
      blockNumber: Number(row.blockNumber),
      transactionHash: row.transactionHash,
      transactionIndex: row.transactionIndex,
      logIndex: row.logIndex,
    });
  }

  private validateEventChain(chain: EventChain): void {
    if (!chain.events.length) throw new UserError('Empty event chain');
    if (chain.events.some((event) => !event.signature || !event.signerAddress)) {
      throw new UserError('Invalid event chain');
    }
  }

  private parseNftInfoFromChain(chain: EventChain): NFTInfo {
    const parsed = chain.events[0]?.parsedData;
    if (!parsed?.nft?.network || !parsed?.nft?.address || parsed?.nft?.id === undefined) {
      throw new UserError('Invalid event chain: missing NFT metadata in first event');
    }
    return { network: parsed.nft.network, address: parsed.nft.address, id: String(parsed.nft.id) };
  }

  private async replayStoredOwnable(cid: string): Promise<ReplayDerivedState> {
    const eventChainBuffer = await this.storage.getEventChain(cid);
    const chain = EventChain.from(JSON.parse(eventChainBuffer.toString('utf8')));
    this.validateEventChain(chain);

    const zipped = new JSZip();
    await zipped.loadAsync(await this.storage.getPackageZip(cid), { createFolders: true });
    zipped.file('eventChain.json', eventChainBuffer);
    const files = await this.unzip(await zipped.generateAsync({ type: 'uint8array' }));
    const contract = await this.loadContractFromFiles(files);

    for (const event of chain.events) {
      await this.applyEvent(contract, event);
    }

    const indexedEvents = await this.hubState.listWalletEventsByCid(cid);
    const publicRows = indexedEvents.filter((row) => row.eventKind === 'public');

    const appliedReplayKeys: string[] = [];
    let latestAppliedPublicEventId: string | null = null;

    for (const row of publicRows) {
      const replay = this.toReplayEvent(row);
      if (!replay) continue;
      try {
        await this.applyEvent(contract, replay);
        appliedReplayKeys.push(publicEventReplayKey({ transactionHash: row.transactionHash, logIndex: row.logIndex }));
        latestAppliedPublicEventId = row.id;
      } catch {
        // freshness check below converts this into stable stale contract
        break;
      }
    }

    const freshness = evaluateReplayFreshness(
      publicRows
        .filter((row) => !!row.sourceAddress && !!row.eventType && !!row.dataHex)
        .map((row) => ({
          source: row.sourceAddress as string,
          eventType: row.eventType as string,
          data: row.dataHex as string,
          blockNumber: Number(row.blockNumber),
          transactionHash: row.transactionHash,
          transactionIndex: row.transactionIndex,
          logIndex: row.logIndex,
        })),
      appliedReplayKeys,
    );

    if (freshness.stale) {
      throw new UserError(`STALE_OWNABLE missingReplayKeys=${freshness.missingReplayKeys.join(',')}`);
    }

    const info = await contract.query({ get_info: {} });
    const owner = String(info.owner ?? '').toLowerCase();
    if (!owner) throw new UserError('Unable to derive owner from replayed state');

    return {
      nftInfo: this.parseNftInfoFromChain(chain),
      owner,
      latestAppliedPublicEventId,
    };
  }

  private async requireNftOwner(nftInfo: NFTInfo, signer?: SignerIdentity): Promise<string> {
    if (!signer?.address) throw new AuthError('Missing SIWE signer');

    const currentNftOwner = await this.nft.getOwnerOfNFT(nftInfo);
    if (currentNftOwner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new UserError(`Signer ${signer.address} is not current NFT owner ${currentNftOwner}`);
    }

    return signer.address;
  }

  public async getOwnableCidFromNFT(nftInfo: NFTInfo): Promise<JSON> {
    const record = await this.hubState.getOwnableByNft(nftInfo.network, nftInfo.address, nftInfo.id.toString());
    if (!record) throw new UserError(`No CID available for nftInfo ${JSON.stringify(nftInfo)}`);

    const nftOwner: string = await this.nft.getOwnerOfNFT(nftInfo);
    return JSON.parse(
      JSON.stringify({
        OwnableCid: record.cid,
        OwnableLastOwner: record.prevOwnerAddress,
        network: nftInfo.network,
        id: nftInfo.id.toString(),
        smartContractAddress: nftInfo.address,
        nftOwner,
      }),
    );
  }

  public async getAvailableNftChains(): Promise<JSON> {
    const contractAddress = this.getBaseContractAddress();
    const nftInfoBase: NFTInfo = { network: 'eip155:base', id: '0', address: contractAddress };
    const nftCountBase = await this.nft.getNFTcount(nftInfoBase);

    return JSON.parse(
      JSON.stringify({
        base: 'eip155:base',
        baseContractAddress: contractAddress,
        totalAmountBaseNFTs: nftCountBase.toString(),
      }),
    );
  }

  private getBaseContractAddress(): string {
    return this.getBaseNftContractAddressForProfile(this.config.getRuntimeNetworkProfile());
  }

  private getBaseNftContractAddressForProfile(profile: RuntimeNetworkProfile): string {
    if (profile === 'testnet') return process.env.TESTNET_BASE_NFT_CONTRACT_ADDRESS?.trim() || '';
    return process.env.MAINNET_BASE_NFT_CONTRACT_ADDRESS?.trim() || '';
  }

  async existsCid(cid: string): Promise<boolean> {
    return await this.storage.hasEventChain(cid);
  }

  async existsPkg(pkg: string): Promise<boolean> {
    return await this.storage.hasPackage(pkg);
  }

  private async unzip(data: Uint8Array): Promise<Map<string, Buffer>> {
    const zip = new JSZip();
    const archive = await zip.loadAsync(data, { createFolders: true });
    const entries: Array<[string, Buffer]> = await Promise.all(
      Object.entries(archive.files)
        .filter(([filename]) => filename !== 'chain.json')
        .map(async ([filename, file]) => [filename, await file.async('nodebuffer')]),
    );
    return new Map(entries);
  }

  public async isUnlockProofValid(network: string, address: string, id: string, proof: string): Promise<boolean> {
    try {
      return await this.nft.isUnlockProofValid(proof, { network, address, id });
    } catch (err) {
      throw new UserError(`function call isUnlockProofValid to smart contract failed with Error: ${err}`);
    }
  }

  public getBridgedOwnableCIDs(signer?: SignerIdentity): Promise<string[]> {
    const ownerAddress = signer?.address?.toLowerCase();
    if (!ownerAddress) return Promise.resolve([]);
    return this.hubState.listOwnableCidsByPrevOwner(ownerAddress);
  }

  private async getCid(files: Map<string, Buffer>): Promise<string> {
    return calculateOwnablePackageCid(
      Array.from(files.entries()).map(([filename, content]) => ({ path: filename, content })),
    );
  }

  public async getUnlockProof(cid: string, signer?: SignerIdentity): Promise<string> {
    if (!signer?.address) throw new AuthError('Missing SIWE signer');

    const record = await this.hubState.getOwnableByCid(cid);
    if (!record) throw new UserError('CID not found. Ownable copy is not registered on hub.');
    if (!(await this.existsPkg(cid))) throw new UserError('Ownable package with CID is not available on server.');

    const replayState = await this.replayStoredOwnable(cid);
    await this.requireNftOwner(replayState.nftInfo, signer);

    try {
      const locked = await this.nft.isNFTlocked({
        network: replayState.nftInfo.network,
        address: replayState.nftInfo.address,
        id: replayState.nftInfo.id,
      });
      if (!locked) {
        throw new UserError(
          `NFT ${replayState.nftInfo.id} is NOT LOCKED ! Network ${replayState.nftInfo.network} and NFT smart contract ${replayState.nftInfo.address}`,
        );
      }
    } catch (err) {
      throw new UserError(`function call isNFTlocked to smart contract failed with Error: ${err}`);
    }

    return await this.nft.getUnlockProof({
      network: replayState.nftInfo.network,
      address: replayState.nftInfo.address,
      id: replayState.nftInfo.id,
    });
  }

  async uploadOwnable(buffer: Uint8Array, signer?: SignerIdentity, verbose = false): Promise<any> {
    if (verbose) console.log('unzipping Zip files into memory');
    const files = await this.unzip(buffer);

    if (!files.has('eventChain.json')) throw new Error("Invalid package: 'eventChain.json' is missing");

    const eventChainBuffer = files.get('eventChain.json') as Buffer;
    const eventChainJson = JSON.parse(eventChainBuffer.toString());
    const chain = EventChain.from(eventChainJson);
    this.validateEventChain(chain);

    const nftInfo = this.parseNftInfoFromChain(chain);
    const ownerFromPrivateState = chain.events.at(-1)?.signerAddress?.toLowerCase() ?? signer?.address?.toLowerCase() ?? '';

    if (verbose) console.log('removing eventChain.json from files to create CID');
    files.delete('eventChain.json');
    const cid = await this.getCid(files);

    const newZip = new JSZip();
    await newZip.loadAsync(buffer, { createFolders: true });
    newZip.remove('eventChain.json');
    const content = await newZip.generateAsync({ type: 'uint8array' });

    await this.storage.storePackageArtifacts(cid, content, files);
    await this.storage.storeEventChain(cid, eventChainBuffer);

    const record = await this.hubState.upsertOwnableRecord({
      cid,
      prevOwnerAddress: ownerFromPrivateState || '0x0000000000000000000000000000000000000000',
      subjectId: chain.id,
      nftNetwork: nftInfo.network,
      nftContractAddress: nftInfo.address,
      nftTokenId: nftInfo.id,
    });

    if (ownerFromPrivateState) {
      await this.hubState.setOwnerState(record.id, ownerFromPrivateState);
    }

    return {
      cid: cid.toString(),
      owner: ownerFromPrivateState,
      nftNetwork: nftInfo.network,
      smartContractAddress: nftInfo.address,
      NftId: nftInfo.id,
    };
  }

  async bridgeOwnable(buffer: Uint8Array, signer?: SignerIdentity, verbose = false): Promise<any> {
    return this.uploadOwnable(buffer, signer, verbose);
  }

  async downloadOwnable(cid: string): Promise<StreamableFile> {
    const record = await this.hubState.getOwnableByCid(cid);
    if (!record) throw new UserError(`Event chain with cid ${cid} not available on this hub`);
    if (!(await this.existsCid(cid))) throw new UserError(`Event chain with cid ${cid} not available on this hub`);
    if (!(await this.existsPkg(cid))) throw new UserError(`Ownable package with cid ${cid} not available on this hub`);

    const replayState = await this.replayStoredOwnable(cid);
    await this.hubState.setOwnerState(record.id, replayState.owner, replayState.latestAppliedPublicEventId);

    const zipped = new JSZip();
    const zipFile = await this.storage.getPackageZip(cid);
    await zipped.loadAsync(zipFile, { createFolders: true });
    zipped.file('eventChain.json', await this.storage.getEventChain(cid));

    const content = await zipped.generateAsync({ type: 'uint8array' });
    return new StreamableFile(Readable.from(Buffer.from(content)));
  }

  async claimOwnable(cid: string, signer?: SignerIdentity): Promise<StreamableFile> {
    void signer;
    return this.downloadOwnable(cid);
  }

  async getOwnableEvents(cid: string): Promise<IndexedWalletEvent[]> {
    if (!(await this.existsCid(cid))) {
      throw new UserError(`Event chain with cid ${cid} not available on this hub`);
    }
    return this.hubState.listWalletEventsByCid(cid);
  }
}
