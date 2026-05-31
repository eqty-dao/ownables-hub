import { Injectable, OnModuleInit, StreamableFile } from '@nestjs/common';
import { calculateOwnablePackageCid } from '@ownables/core';
import { PackageService } from '../package/package.service.js';
import { ConfigService, RuntimeNetworkProfile } from '../common/config/config.service.js';
import { CosmWasmService } from '../cosmwasm/cosmwasm.service.js';
import Contract from '../cosmwasm/contract.js';
import { NFTInfo } from '../interfaces/OwnableInfo.js';
import { NFTService } from '../nft/nft.service.js';
import { HttpService } from '@nestjs/axios';
import { AuthError, UserError } from '../interfaces/error.js';
import JSZip from 'jszip';
import { Event, EventChain } from 'eqty-core';
import { ethers } from 'ethers';
import { Readable } from 'stream';
import { ArchiveStorageService } from '../storage/archive-storage.service.js';
import { HubStateRepository } from '../persistence/repos/hub-state.repository.js';

interface SignerIdentity {
  address?: string;
}

@Injectable()
export class OwnableService implements OnModuleInit {
  private readonly authoritySigner: {
    getAddress: () => Promise<string>;
    signTypedData: (domain: any, types: Record<string, any[]>, value: any) => Promise<string>;
  };

  constructor(
    private packages: PackageService,
    private config: ConfigService,
    private cosmWasm: CosmWasmService,
    private nft: NFTService,
    private http: HttpService,
    private readonly storage: ArchiveStorageService,
    private readonly hubState: HubStateRepository,
  ) {
    const mnemonic = this.config.getAuthoritySignerMnemonic();
    if (!mnemonic) {
      throw new Error('Missing account mnemonic configuration');
    }
    const authorityWallet = ethers.Wallet.fromPhrase(mnemonic);
    this.authoritySigner = {
      getAddress: async () => authorityWallet.address,
      signTypedData: async (domain: any, types: Record<string, any[]>, value: any) =>
        authorityWallet.signTypedData(domain, types, value),
    };
  }

  async onModuleInit() {}

  public async GetServerETHBalance(networkName: string): Promise<string> {
    return await this.nft.GetServerETHBalance(networkName);
  }

  private async applyEvent(contract: Contract, event: Event): Promise<void> {
    const info: { sender: string; funds: [] } = {
      sender: event.signerAddress ?? '',
      funds: [],
    };
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

  public async getOwnableCidFromNFT(nftInfo: NFTInfo): Promise<JSON> {
    const record = await this.hubState.getOwnableByNft(nftInfo.network, nftInfo.address, nftInfo.id.toString());
    if (!record) {
      throw new UserError(`No CID available for nftInfo ${JSON.stringify(nftInfo)}`);
    }

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
    const nftInfoBase: NFTInfo = {
      network: 'eip155:base',
      id: '0',
      address: contractAddress,
    };

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
    if (profile === 'testnet') {
      return process.env.TESTNET_BASE_NFT_CONTRACT_ADDRESS?.trim() || '';
    }

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
      return await this.nft.isUnlockProofValid(proof, {
        network,
        address,
        id,
      });
    } catch (err) {
      throw new UserError(`function call isUnlockProofValid to smart contract failed with Error: ${err}`);
    }
  }

  public getBridgedOwnableCIDs(signer?: SignerIdentity): Promise<string[]> {
    const ownerAddress = signer?.address?.toLowerCase();
    if (!ownerAddress) {
      return Promise.resolve([]);
    }

    return this.hubState.listOwnableCidsByPrevOwner(ownerAddress);
  }

  private async getCid(files: Map<string, Buffer>): Promise<string> {
    return calculateOwnablePackageCid(
      Array.from(files.entries()).map(([filename, content]) => ({
        path: filename,
        content,
      })),
    );
  }

  private validateEventChain(chain: EventChain): void {
    if (!chain.events.length) {
      throw new UserError('Empty event chain');
    }
    const hasUnsignedEvent = chain.events.some((event) => !event.signature || !event.signerAddress);
    if (hasUnsignedEvent) {
      throw new UserError('Invalid event chain');
    }
  }

  private parseNftInfoFromChain(chain: EventChain): NFTInfo {
    const parsed = chain.events[0]?.parsedData;
    if (!parsed?.nft?.network || !parsed?.nft?.address || parsed?.nft?.id === undefined) {
      throw new UserError('Invalid event chain: missing NFT metadata in first event');
    }

    return {
      network: parsed.nft.network,
      address: parsed.nft.address,
      id: String(parsed.nft.id),
    };
  }

  private async requireNftOwner(nftInfo: NFTInfo, signer?: SignerIdentity): Promise<string> {
    if (!signer?.address) {
      throw new AuthError('Missing SIWE signer');
    }

    const currentNftOwner = await this.nft.getOwnerOfNFT(nftInfo);
    if (currentNftOwner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new UserError(`Signer ${signer.address} is not current NFT owner ${currentNftOwner}`);
    }

    return signer.address;
  }

  public async getUnlockProof(cid: string, signer?: SignerIdentity): Promise<string> {
    const record = await this.hubState.getOwnableByCid(cid);
    if (!record) {
      throw new UserError('CID not found. Ownable copy is not registered on hub.');
    }

    if (!(await this.existsPkg(cid))) {
      throw new UserError('Ownable package with CID is not available on server.');
    }

    if (!record.nftNetwork || !record.nftContractAddress || !record.nftTokenId) {
      throw new UserError('CID is not linked to NFT metadata.');
    }

    try {
      const locked = await this.nft.isNFTlocked({
        network: record.nftNetwork,
        address: record.nftContractAddress,
        id: record.nftTokenId,
      });

      if (!locked) {
        throw new UserError(
          `NFT ${record.nftTokenId} is NOT LOCKED ! Network ${record.nftNetwork} and NFT smart contract ${record.nftContractAddress}`,
        );
      }

      if (signer?.address) {
        await this.requireNftOwner(
          {
            network: record.nftNetwork,
            address: record.nftContractAddress,
            id: String(record.nftTokenId),
          },
          signer,
        );
      }
    } catch (err) {
      throw new UserError(`function call isNFTlocked to smart contract failed with Error: ${err}`);
    }

    return await this.nft.getUnlockProof({
      network: record.nftNetwork,
      address: record.nftContractAddress,
      id: record.nftTokenId,
    });
  }

  async bridgeOwnable(buffer: Uint8Array, signer?: SignerIdentity, verbose = false): Promise<any> {
    if (verbose) console.log('unzipping Zip files into memory');
    const files = await this.unzip(buffer);

    if (!files.has('eventChain.json')) {
      throw new Error("Invalid package: 'eventChain.json' is missing");
    }

    const eventChainBuffer = files.get('eventChain.json') as Buffer;
    const eventChainJson = JSON.parse(eventChainBuffer.toString());
    const chain = EventChain.from(eventChainJson);

    this.validateEventChain(chain);

    const nftInfo = this.parseNftInfoFromChain(chain);
    const signerAddress = await this.requireNftOwner(nftInfo, signer);

    if (verbose) console.log('removing eventChain.json from files to create CID');
    files.delete('eventChain.json');
    const cid = await this.getCid(files);

    if (verbose) console.log('Storing Zip file without eventChain.json');
    const newZip = new JSZip();
    await newZip.loadAsync(buffer, { createFolders: true });
    newZip.remove('eventChain.json');
    const content = await newZip.generateAsync({ type: 'uint8array' });

    await this.storage.storePackageArtifacts(cid, content, files);
    await this.storage.storeEventChain(cid, eventChainBuffer);

    const record = await this.hubState.upsertOwnableRecord({
      cid,
      prevOwnerAddress: signerAddress,
      nftNetwork: nftInfo.network,
      nftContractAddress: nftInfo.address,
      nftTokenId: nftInfo.id,
    });
    await this.hubState.setOwnerState(record.id, signerAddress);

    return {
      cid: cid.toString(),
      owner: signerAddress,
      nftNetwork: nftInfo.network,
      smartContractAddress: nftInfo.address,
      NftId: nftInfo.id,
    };
  }

  async claimOwnable(cid: string, signer?: SignerIdentity): Promise<StreamableFile> {
    if (!(await this.existsCid(cid))) {
      throw new UserError(`Event chain with cid ${cid} not available on this hub`);
    }
    if (!(await this.existsPkg(cid))) {
      throw new UserError(`Ownable package with cid ${cid} not available on this hub`);
    }

    const eventChainJsonFile = (await this.storage.getEventChain(cid)).toString('utf8');
    const chain = EventChain.from(JSON.parse(eventChainJsonFile));

    this.validateEventChain(chain);
    const nftInfo = this.parseNftInfoFromChain(chain);
    await this.requireNftOwner(nftInfo, signer);

    const newEvent = new Event({ '@context': 'authority_claim_msg.json', cid, claimer: signer?.address ?? '' });
    await newEvent.addTo(chain).signWith(this.authoritySigner);

    const zipped = new JSZip();
    const zipFile = await this.storage.getPackageZip(cid);
    await zipped.loadAsync(zipFile, { createFolders: true });
    zipped.file('eventChain.json', Buffer.from(JSON.stringify(chain.toJSON(), null, 2), 'utf8'));

    const content = await zipped.generateAsync({ type: 'uint8array' });
    return new StreamableFile(Readable.from(Buffer.from(content)));
  }
}
