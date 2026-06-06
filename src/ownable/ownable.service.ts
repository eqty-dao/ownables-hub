import { Injectable, OnModuleInit, StreamableFile } from '@nestjs/common';
import {
  calculateOwnablePackageCid,
  evaluateReplayFreshness,
  OwnableService as CoreOwnableService,
  EventChainService as CoreEventChainService,
  type IndexedPublicEvent,
  type StateStore,
  type TypedPackage,
  type AnchorProvider,
} from '@ownables/core';
import { NodePackageAssetIO, NodeSandboxOwnableRPC } from '@ownables/platform-node';
import { ConfigService, RuntimeNetworkProfile } from '../common/config/config.service.js';
import { NFTInfo } from '../interfaces/OwnableInfo.js';
import { NFTService } from '../nft/nft.service.js';
import { AuthError, UserError } from '../interfaces/error.js';
import JSZip from 'jszip';
import { EventChain } from 'eqty-core';
import { Readable } from 'stream';
import { ArchiveStorageService } from '../storage/archive-storage.service.js';
import { HubStateRepository, IndexedWalletEvent } from '../persistence/repos/hub-state.repository.js';
import { NotifyService } from '../notify/notify.service.js';

interface SignerIdentity {
  address?: string;
}

interface ReplayDerivedState {
  nftInfo: NFTInfo;
  owner: string;
  latestAppliedPublicEventId: string | null;
}

class InMemoryStateStore implements StateStore {
  private readonly stores = new Map<string, Map<any, any>>();

  async get(store: string, key: string): Promise<any> {
    return this.stores.get(store)?.get(key);
  }

  async getAll(store: string): Promise<Array<any>> {
    return Array.from(this.stores.get(store)?.values() ?? []);
  }

  async getMap(store: string): Promise<Map<any, any>> {
    return new Map(this.stores.get(store) ?? []);
  }

  async keys(store: string): Promise<string[]> {
    return Array.from(this.stores.get(store)?.keys() ?? []);
  }

  async set(store: string, key: string, value: any): Promise<void> {
    if (!this.stores.has(store)) this.stores.set(store, new Map());
    this.stores.get(store)?.set(key, value);
  }

  async setAll(store: string, map: Record<string, any> | Map<any, any>): Promise<void>;
  async setAll(data: Record<string, Record<string, any> | Map<any, any>>): Promise<void>;
  async setAll(
    storeOrData: string | Record<string, Record<string, any> | Map<any, any>>,
    mapMaybe?: Record<string, any> | Map<any, any>,
  ): Promise<void> {
    if (typeof storeOrData === 'string') {
      const store = storeOrData;
      const mapOrObj = mapMaybe;
      if (!mapOrObj) return;
      if (!this.stores.has(store)) this.stores.set(store, new Map());
      const storeMap = this.stores.get(store) as Map<any, any>;
      if (mapOrObj instanceof Map) {
        for (const [k, v] of mapOrObj.entries()) storeMap.set(k, v);
      } else {
        for (const [k, v] of Object.entries(mapOrObj)) storeMap.set(k, v);
      }
      return;
    }

    for (const [store, mapOrObj] of Object.entries(storeOrData)) {
      if (!this.stores.has(store)) this.stores.set(store, new Map());
      const storeMap = this.stores.get(store) as Map<any, any>;
      if (mapOrObj instanceof Map) {
        for (const [k, v] of mapOrObj.entries()) storeMap.set(k, v);
      } else {
        for (const [k, v] of Object.entries(mapOrObj)) storeMap.set(k, v);
      }
    }
  }

  async hasStore(store: string): Promise<boolean> {
    return this.stores.has(store);
  }

  async createStore(...stores: string[]): Promise<void> {
    for (const store of stores) if (!this.stores.has(store)) this.stores.set(store, new Map());
  }

  async deleteStore(store: string | RegExp): Promise<void> {
    if (typeof store === 'string') {
      this.stores.delete(store);
      return;
    }
    for (const name of this.stores.keys()) {
      if (store.test(name)) this.stores.delete(name);
    }
  }

  async listStores(): Promise<string[]> {
    return Array.from(this.stores.keys());
  }

  async delete(store: string, key: string): Promise<void> {
    this.stores.get(store)?.delete(key);
  }
}

@Injectable()
export class OwnableService implements OnModuleInit {
  constructor(
    private config: ConfigService,
    private nft: NFTService,
    private readonly storage: ArchiveStorageService,
    private readonly hubState: HubStateRepository,
    private readonly notifyService: NotifyService,
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

  private toIndexedPublicEvent(row: IndexedWalletEvent): IndexedPublicEvent | null {
    if (row.eventKind !== 'public' || !row.sourceAddress || !row.eventType || !row.dataHex) {
      return null;
    }

    return {
      source: row.sourceAddress,
      eventType: row.eventType,
      data: row.dataHex,
      blockNumber: Number(row.blockNumber),
      transactionHash: row.transactionHash,
      transactionIndex: row.transactionIndex,
      logIndex: row.logIndex,
    };
  }

  private async replayStoredOwnable(cid: string): Promise<ReplayDerivedState> {
    const eventChainBuffer = await this.storage.getEventChain(cid);
    const chain = EventChain.from(JSON.parse(eventChainBuffer.toString('utf8')));
    this.validateEventChain(chain);

    const zipped = new JSZip();
    await zipped.loadAsync(await this.storage.getPackageZip(cid), { createFolders: true });
    zipped.file('eventChain.json', eventChainBuffer);
    const files = await this.unzip(await zipped.generateAsync({ type: 'uint8array' }));

    const stateStore = new InMemoryStateStore();
    const anchorProvider: AnchorProvider = {
      address: '0x0000000000000000000000000000000000000000',
      chainId: 0,
      signer: null,
      sign: async () => {},
      anchor: async () => {},
      submitAnchors: async () => undefined,
      emitPublicEvent: async () => {
        throw new Error('emitPublicEvent is not supported in hub replay');
      },
      verifyAnchors: async () => ({ verified: true, anchors: {}, map: {} }),
    };

    const packageInfo: TypedPackage = {
      title: cid,
      name: cid,
      cid,
      isDynamic: true,
      hasMetadata: false,
      hasWidgetState: false,
      isConsumable: false,
      isConsumer: false,
      isTransferable: false,
      versions: [{ date: new Date(), cid }],
    };

    const packageAssetIO = new NodePackageAssetIO({
      infoResolver: () => packageInfo,
      assetLoader: async (_packageCid, name) => files.get(name),
      assetList: async () => Array.from(files.keys()),
    });

    const eventChains = new CoreEventChainService(stateStore, anchorProvider);
    const coreOwnables = new CoreOwnableService(
      stateStore,
      eventChains,
      anchorProvider,
      packageAssetIO,
      undefined,
      console,
      { create: (id: string) => new NodeSandboxOwnableRPC(id) },
    );

    await coreOwnables.initWorker(chain.id, cid);
    const privateStateDump = await coreOwnables.apply(chain, []);

    const indexedRows = await this.hubState.listWalletEventsByCid(cid);
    const indexedEventsWithRowId = indexedRows
      .map((row) => ({ rowId: row.id, event: this.toIndexedPublicEvent(row) }))
      .filter((value): value is { rowId: string; event: IndexedPublicEvent } => Boolean(value.event));
    const indexedEvents = indexedEventsWithRowId.map(({ event }) => event);
    const replay = await coreOwnables.attemptReplayIndexedPublicEvents(chain.id, privateStateDump, indexedEvents);

    const freshness = evaluateReplayFreshness(indexedEvents, replay.appliedReplayKeys);

    if (freshness.stale) {
      throw new UserError(`STALE_OWNABLE missingReplayKeys=${freshness.missingReplayKeys.join(',')}`);
    }

    const info = await coreOwnables.rpc(chain.id).query({ get_info: {} }, replay.stateDump);
    const owner = String(info.owner ?? '').toLowerCase();
    if (!owner) throw new UserError('Unable to derive owner from replayed state');

    const latestAppliedPublicEvent = replay.appliedEvents.at(-1);
    const latestAppliedPublicEventId =
      latestAppliedPublicEvent === undefined
        ? null
        : indexedEventsWithRowId.find(
            ({ event }) =>
              event.transactionHash === latestAppliedPublicEvent.transactionHash &&
              event.logIndex === latestAppliedPublicEvent.logIndex,
          )?.rowId ?? null;

    coreOwnables.clearRpc(chain.id);

    return {
      nftInfo: this.parseNftInfoFromChain(chain),
      owner,
      latestAppliedPublicEventId: latestAppliedPublicEventId ?? null,
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

    const replayState = await this.replayStoredOwnable(cid);
    await this.hubState.setOwnerState(record.id, replayState.owner, replayState.latestAppliedPublicEventId);
    const ownerState = await this.hubState.getOwnerStateByCid(cid);
    if (ownerState) {
      try {
        await this.notifyService.notifyOwnableAvailability({
          ownerAddress: replayState.owner,
          ownerNetwork: replayState.nftInfo.network,
          ownableId: record.id,
          cid,
          ownerStateVersion: ownerState.version,
          latestAppliedPublicEventId: ownerState.latestAppliedPublicEventId,
          issuerAddress: record.prevOwnerAddress,
          nftNetwork: replayState.nftInfo.network,
          nftContractAddress: replayState.nftInfo.address,
          nftTokenId: replayState.nftInfo.id,
          triggerKind: 'upload',
        });
      } catch (error) {
        console.warn('notifyOwnableAvailability warning during upload', error);
      }
    }

    return {
      cid: cid.toString(),
      owner: replayState.owner,
      nftNetwork: replayState.nftInfo.network,
      smartContractAddress: replayState.nftInfo.address,
      NftId: replayState.nftInfo.id,
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

    const ownerStateBefore = await this.hubState.getOwnerStateByCid(cid);
    const replayState = await this.replayStoredOwnable(cid);
    await this.hubState.setOwnerState(record.id, replayState.owner, replayState.latestAppliedPublicEventId);
    const ownerStateAfter = await this.hubState.getOwnerStateByCid(cid);
    const shouldNotify =
      ownerStateAfter &&
      (!ownerStateBefore ||
        ownerStateBefore.owner !== ownerStateAfter.owner ||
        ownerStateBefore.latestAppliedPublicEventId !== ownerStateAfter.latestAppliedPublicEventId);
    if (shouldNotify && ownerStateAfter) {
      try {
        await this.notifyService.notifyOwnableAvailability({
          ownerAddress: replayState.owner,
          ownerNetwork: replayState.nftInfo.network,
          ownableId: record.id,
          cid: record.cid,
          ownerStateVersion: ownerStateAfter.version,
          latestAppliedPublicEventId: ownerStateAfter.latestAppliedPublicEventId,
          issuerAddress: record.prevOwnerAddress,
          nftNetwork: replayState.nftInfo.network,
          nftContractAddress: replayState.nftInfo.address,
          nftTokenId: replayState.nftInfo.id,
          triggerKind: 'download_replay',
        });
      } catch (error) {
        console.warn('notifyOwnableAvailability warning during download replay', error);
      }
    }

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
