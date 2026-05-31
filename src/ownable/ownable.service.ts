import { Injectable, OnModuleInit, StreamableFile } from '@nestjs/common';
import { calculateOwnablePackageCid } from '@ownables/core';
import { PackageService } from '../package/package.service.js';
import { ConfigService } from '../common/config/config.service.js';
import { CosmWasmService } from '../cosmwasm/cosmwasm.service.js';
import Contract from '../cosmwasm/contract.js';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, createReadStream } from 'fs';
import { NFTInfo } from '../interfaces/OwnableInfo.js';
import { NFTService } from '../nft/nft.service.js';
import { HttpService } from '@nestjs/axios';
import { AuthError, UserError } from '../interfaces/error.js';
import fileExists from '../utils/fileExists.js';
import JSZip from 'jszip';
import path from 'path';
import { exec } from 'child_process';
import { Event, EventChain } from 'eqty-core';
import { ethers } from 'ethers';

interface SignerIdentity {
  address?: string;
}

@Injectable()
export class OwnableService implements OnModuleInit {
  private readonly pathToPkgs: string;
  private readonly pathToCids: string;
  private readonly pathToUsers: string;
  private readonly pathToNfts: string;
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
  ) {
    const paths = this.config.getStoragePaths();
    this.pathToPkgs = paths.packages;
    this.pathToCids = paths.chains;
    this.pathToUsers = paths.users;
    this.pathToNfts = paths.nfts;

    const mnemonic = this.config.getAccountMnemonic();
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

  async onModuleInit() {
    mkdirSync(this.pathToPkgs, { recursive: true });
    mkdirSync(this.pathToCids, { recursive: true });
    mkdirSync(this.pathToUsers, { recursive: true });
    mkdirSync(this.pathToNfts, { recursive: true });
  }

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
    let cid: string | undefined;
    let cidOwner: string | undefined;

    try {
      const files = readdirSync(`${this.pathToNfts}/`);
      const mappingPattern = new RegExp(`${nftInfo.network}_${nftInfo.address}_${nftInfo.id}_`, 'g');
      for (const file of files) {
        if (!file.match(mappingPattern)) continue;
        const fileParts = file.split('_');
        cid = fileParts[3]?.toString();
      }
    } catch {
      // ignore and let validation below return a user-facing error
    }

    try {
      if (!cid) throw new Error('CID missing');
      const files = readdirSync(`${this.pathToUsers}/`);
      const ownerPattern = new RegExp(`${cid}_`, 'g');
      for (const file of files) {
        if (!file.match(ownerPattern)) continue;
        const fileParts = file.split('_');
        cidOwner = fileParts[1]?.toString();
      }
    } catch {
      // ignore and let validation below return a user-facing error
    }

    if (!cid) {
      throw new UserError(`No CID available for nftInfo ${JSON.stringify(nftInfo)}`);
    }

    const nftOwner: string = await this.nft.getOwnerOfNFT(nftInfo);

    return JSON.parse(
      JSON.stringify({
        OwnableCid: cid,
        OwnableLastOwner: cidOwner,
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
    return this.config.getBaseNftContractAddress();
  }

  async existsCid(cid: string): Promise<boolean> {
    return await fileExists(`${this.pathToCids}/${cid}/eventChain.json`);
  }

  async existsPkg(pkg: string): Promise<boolean> {
    return await fileExists(`${this.pathToPkgs}/${pkg}/${pkg}.zip`);
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

  private async storeFiles(destPath: string, cid: string, files: Map<string, Buffer>): Promise<void> {
    const dir = path.join(destPath, cid);
    mkdirSync(dir, { recursive: true });

    await Promise.all(
      Array.from(files.entries()).map(([filename, content]) => writeFileSync(path.join(dir, filename), content)),
    );
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

  public getBridgedOwnableCIDs(signer?: SignerIdentity): string[] {
    const ownerAddress = signer?.address?.toLowerCase();
    if (!ownerAddress) return [];

    const bridgedOwnableCIDs: string[] = [];

    try {
      const files = readdirSync(`${this.pathToUsers}/`);
      const filePattern = new RegExp(`^(.+)_${ownerAddress}_bridged$`, 'i');
      for (const file of files) {
        const match = file.match(filePattern);
        if (!match?.[1]) continue;
        bridgedOwnableCIDs.push(match[1]);
      }
    } catch {
      return [];
    }

    return bridgedOwnableCIDs;
  }

  private async getCid(files: Map<string, Buffer>): Promise<string> {
    return calculateOwnablePackageCid(Array.from(files.entries()).map(([filename, content]) => ({
      path: filename,
      content,
    })));
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
    let cidInfoFile: string | undefined;

    try {
      const files = readdirSync(`${this.pathToUsers}/`);
      const filePattern = new RegExp(`^${cid}_.+_bridged$`, 'g');
      for (const file of files) {
        if (file.match(filePattern)) {
          cidInfoFile = file;
        }
      }
    } catch {
      // no-op
    }

    if (!cidInfoFile) {
      throw new UserError('CID not found. Ownable copy is not registered on hub.');
    }

    const cidInfo = JSON.parse(readFileSync(`${this.pathToUsers}/${cidInfoFile}`).toString());

    if (!(await this.existsPkg(cid))) {
      throw new UserError('Ownable package with CID is not available on server.');
    }

    try {
      const locked = await this.nft.isNFTlocked({
        network: cidInfo.network,
        address: cidInfo.smartContractAddress,
        id: cidInfo.NftId,
      });

      if (!locked) {
        throw new UserError(
          `NFT ${cidInfo.NftId} is NOT LOCKED ! Network ${cidInfo.network} and NFT smart contract ${cidInfo.smartContractAddress}`,
        );
      }

      if (signer?.address) {
        await this.requireNftOwner(
          {
            network: cidInfo.network,
            address: cidInfo.smartContractAddress,
            id: String(cidInfo.NftId),
          },
          signer,
        );
      }
    } catch (err) {
      throw new UserError(`function call isNFTlocked to smart contract failed with Error: ${err}`);
    }

    return await this.nft.getUnlockProof({
      network: cidInfo.network,
      address: cidInfo.smartContractAddress,
      id: cidInfo.NftId,
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

    mkdirSync(`${this.pathToPkgs}/${cid}`, { recursive: true });
    writeFileSync(`${this.pathToPkgs}/${cid}/${cid}.zip`, content);
    await this.storeFiles(this.pathToPkgs, cid, files);

    const eventChainMap: Map<string, Buffer> = new Map().set('eventChain.json', eventChainBuffer);
    await this.storeFiles(this.pathToCids, cid, eventChainMap);

    const bridgedOwnablesInfo = {
      cid: cid.toString(),
      owner: signerAddress,
      network: nftInfo.network,
      smartContractAddress: nftInfo.address,
      NftId: nftInfo.id,
    };

    const bridgedOwnableFile = `${this.pathToUsers}/${cid}_${signerAddress.toLowerCase()}_bridged`;
    writeFileSync(bridgedOwnableFile, JSON.stringify(bridgedOwnablesInfo));

    const nftToCidMappingFile = `${this.pathToNfts}/${bridgedOwnablesInfo.network}_${bridgedOwnablesInfo.smartContractAddress}_${bridgedOwnablesInfo.NftId}_${cid}_mapped`;
    await this.executeCommand(`touch ${nftToCidMappingFile}`);

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

    const chainFile = `${this.pathToCids}/${cid}/eventChain.json`;
    const eventChainJsonFile = readFileSync(chainFile, { encoding: 'utf8' });
    const chain = EventChain.from(JSON.parse(eventChainJsonFile));

    this.validateEventChain(chain);
    const nftInfo = this.parseNftInfoFromChain(chain);
    await this.requireNftOwner(nftInfo, signer);

    const newEvent = new Event({ '@context': 'authority_claim_msg.json', cid, claimer: signer?.address ?? '' });
    await newEvent.addTo(chain).signWith(this.authoritySigner);

    const zipped = new JSZip();
    const zipFile = readFileSync(`${this.pathToPkgs}/${cid}/${cid}.zip`);
    await zipped.loadAsync(zipFile, { createFolders: true });
    zipped.file('eventChain.json', Buffer.from(JSON.stringify(chain.toJSON(), null, 2), 'utf8'));

    const content = await zipped.generateAsync({ type: 'uint8array' });
    const claimZipPath = `${this.pathToPkgs}/${cid}/${cid}_claimed.zip`;
    writeFileSync(claimZipPath, content);

    const file = createReadStream(claimZipPath);
    return new StreamableFile(file);
  }

  private async executeCommand(command: string) {
    return new Promise((resolve) => {
      exec(command, (_error, stdout, stderr) => {
        resolve(stdout ? stdout : stderr);
      });
    });
  }
}
