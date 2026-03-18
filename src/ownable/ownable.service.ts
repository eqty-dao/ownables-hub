import { Inject, Injectable, OnModuleInit, StreamableFile } from '@nestjs/common';
import { PackageService } from '../package/package.service';
import { Account, Binary, EventChain, Event, LTO } from '@ltonetwork/lto';
import { ConfigService } from '../common/config/config.service';
import { CosmWasmService } from '../cosmwasm/cosmwasm.service';
import Contract from '../cosmwasm/contract';
// import fs from 'fs/promises';
import { rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, createReadStream } from 'fs';
import { NFTInfo, OwnableInfo } from '../interfaces/OwnableInfo';
import { NFTService } from '../nft/nft.service';
import { LtoIndexService } from '../common/lto-index/lto-index.service';
import { HttpService } from '@nestjs/axios';
import { AuthError, UserError } from '../interfaces/error';
import fileExists from '../utils/fileExists';
import JSZip from 'jszip';
import path from 'path';
import { IEventChainJSON } from '@ltonetwork/lto/interfaces';
import { exec } from 'child_process';
import { sign } from '@ltonetwork/http-message-signatures';
interface InfoWithProof extends OwnableInfo {
  proof?: string;
}

@Injectable()
export class OwnableService implements OnModuleInit {
  private readonly pathToPkgs: string;
  private readonly pathToCids: string;
  private readonly pathToUsers: string;
  private readonly pathToNfts: string;

  private lto = new LTO(this.config.get('lto.networkId'));
  private readonly _ltoAccount?: Account = this.lto.account({ seed: this.config.get('lto.account.seed') });
  public readonly networkId = this.lto.networkId;

  constructor(
    private packages: PackageService,
    private config: ConfigService,
    private cosmWasm: CosmWasmService,
    private nft: NFTService,
    private ltoIndex: LtoIndexService,
    private http: HttpService,
    @Inject('IPFS') private readonly ipfs: IPFS,
  ) {
    this.pathToPkgs = this.config.get('path.packages');
    this.pathToCids = this.config.get('path.chains');
    this.pathToUsers = this.config.get('path.users');
    this.pathToNfts = this.config.get('path.nfts');
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

  public getLTOAccountAddress(): string {
    if (!!this._ltoAccount) return this._ltoAccount?.address ?? '';
  }

  public async getLTOAccountBalance(address?: string) {
    if (!address) address = this.getLTOAccountAddress();
    const url = `${this.config.get('lto.node')}/addresses/balance/${address}`;

    const response = await fetch(url);
    if (response.status == 200) {
      const data = await response.json();
      return data;
    } else {
      throw new Error(`Error fetching balance of address: ${address}`);
    }
  }

  public getLTOAccount(): Account {
    if (!this._ltoAccount) {
      throw new Error('Not logged in');
    }
    return this._ltoAccount;
  }
  private async applyEvent(contract: Contract, event: Event): Promise<void> {
    const info: { sender: string; funds: [] } = {
      sender: event.signKey?.publicKey.base58,
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

  // private async loadContract(packageCid: string, chain: EventChain) {
  //   if (!(await this.packages.exists(packageCid))) {
  //     throw new UserError('Unknown ownable package');
  //   }

  //   const contract = await this.cosmWasm.load(
  //     this.packages.file(packageCid, 'ownable.js'),
  //     this.packages.file(packageCid, 'ownable_bg.wasm'),
  //   );

  //   for (const event of chain.events) {
  //     await this.applyEvent(contract, event);
  //   }

  //   return contract;
  // }

  // private verifyChainId(chain: EventChain, nft: NFTInfo): boolean {
  //   const { publicKey, keyType } = chain.events[0].signKey as { publicKey: Binary; keyType: 'ed25519' | 'secp256k1' };
  //   const account = this.lto.account({ publicKey: publicKey.base58, keyType });
  //   const nonce = Binary.concat(
  //     Binary.fromHex(nft.address),
  //     nft.id.match(/^\d+$/) ? Binary.fromInt32(Number(nft.id)) : new Binary(nft.id),
  //   );
  //   const expectedId = new EventChain(account, nonce).id;
  //   console.log('expectedId', expectedId, chain.id);

  //   return chain.id === expectedId;
  // }

  // private async verifyChainOwner(chain: EventChain, nft: NFTInfo): Promise<boolean> {
  //   const { publicKey, keyType } = chain.events[0].signKey as { publicKey: Binary; keyType: 'ed25519' | 'secp256k1' };
  //   const account = this.lto.account({ publicKey: publicKey.base58, keyType });

  //   const issuer = await this.nft.getIssuer(nft);

  //   console.log('issuer', issuer, account.getAddressOnNetwork(nft.network));
  //   return issuer === account.getAddressOnNetwork(nft.network);
  // }

  // private postToWebhook(chain: EventChain, info: OwnableInfo, packageCid: string) {
  //   const webhook = this.config.get('accept.webhook');
  //   if (!webhook) return;

  //   this.http.post(webhook, { chain: chain.toJSON(), ownable: info, packageCid });
  // }

  public async testSignedRequest(): Promise<string> {
    const account = this.lto.account();
    const request: any = {
      headers: { Accept: 'application/zip' },
      method: 'GET',
      url: 'http://localhost:3000/ownables/proof?cid=bafybeich7f34tktr6eszv7x4jqhetqqj3dmwxcumb23s6wh36mjwrxriim',
      // body: JSON.stringify({
      //   cid: 'bafybeich7f34tktr6eszv7x4jqhetqqj3dmwxcumb23s6wh36mjwrxriim',
      // }),
    };

    const signedRequest = await sign(request, { signer: account });
    return signedRequest;
  }
  public async getOwnableCidFromNFT(nftInfo: NFTInfo): Promise<JSON> {
    let cid: string;
    let cidOwner: string;

    try {
      console.log(`Fetching available CIDs according to nftInfo:`);
      const files = readdirSync(`${this.pathToNfts}/`);
      const myReg = new RegExp(`${nftInfo.network}_${nftInfo.address}_${nftInfo.id}_`, 'g');
      console.log('myReg', myReg);
      files.forEach((file) => {
        if (file.match(myReg)) {
          const filesArray = file.split('_');
          cid = filesArray[3].toString();
        }
      });
    } catch (err) {
      console.log(err);
    }
    try {
      console.log(`Fetching last registered owner of CID: ${cid}`);
      const files = readdirSync(`${this.pathToUsers}/`);
      const myReg = new RegExp(`${cid}_`, 'g');
      files.forEach((file) => {
        if (file.match(myReg)) {
          const filesArray = file.split('_');
          cidOwner = filesArray[1].toString();
        }
      });
    } catch (err) {
      console.log(err);
    }

    if (cid === undefined) {
      throw new UserError(`No CID available for nftInfo ${nftInfo}`);
    }
    const nftOwner: string = await this.nft.getOwnerOfNFT(nftInfo);

    const nftOwnableMapping = {
      OwnableCid: cid,
      OwnableLastOwner: cidOwner,
      network: 'eip155:base',
      id: nftInfo.id.toString(),
      smartContractAddress:
        this.config.get('lto.networkId') === 'T'
          ? this.config.get('eth.contracts.base_sepolia')
          : this.config.get('eth.contracts.base'),
      nftOwner: nftOwner,
    };

    return JSON.parse(JSON.stringify(nftOwnableMapping));
  }

  public async getAvailableNftChains(): Promise<JSON> {
    const nftInfoETH: NFTInfo = {
      network: 'eip155:ethereum',
      id: '0',
      address: this.config.get('eth.contracts.ethereum'),
    };

    const nftInfoBase: NFTInfo = {
      network: 'eip155:base',
      id: '0',
      address:
        this.config.get('lto.networkId') === 'T'
          ? this.config.get('eth.contracts.base_sepolia')
          : this.config.get('eth.contracts.base'),
    };

    // const nftInfoPOL: NFTInfo = {
    //   network: 'eip155:polygon',
    //   id: '0',
    //   address: this.config.get('eth.contracts.polygon'),
    // };

    const nftCountETH = await this.nft.getNFTcount(nftInfoETH);
    const nftCountBase = await this.nft.getNFTcount(nftInfoBase);
    // const nftCountPOL = await this.nft.getNFTcount(nftInfoPOL);

    const availableChains = {
      ethereum: 'eip155:ethereum',
      base: 'eip155:base',
      // polygon: 'eip155:polygon',
      ethereumContractAddress: this.config.get('eth.contracts.ethereum'),
      baseContractAddress:
        this.config.get('lto.networkId') === 'T'
          ? this.config.get('eth.contracts.base_sepolia')
          : this.config.get('eth.contracts.base'),
      // polygonContractAddress: this.config.get('eth.contracts.polygon'),
      totalAmountethereumNFTs: nftCountETH.toString(),
      totalAmountBaseNFTs: nftCountBase.toString(),
      // polygonNFTcount: nftCountPOL,
    };

    return JSON.parse(JSON.stringify(availableChains));
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

  private async storeZip(destPath: string, uniqueId: string, data: Uint8Array): Promise<void> {
    const file = path.join(destPath, `${uniqueId}.zip`);
    writeFileSync(file, data);
  }

  public async isUnlockProofValid(network: string, address: string, id: string, proof: string): Promise<boolean> {
    try {
      const isValid = await this.nft.isUnlockProofValid(proof, {
        network: network,
        address: address,
        id: id,
      });
      return isValid;
    } catch (err) {
      throw new UserError(`function call isUnlockProofValid to smart contract failed with Error: ${err}`);
    }
  }

  public getBridgedOwnableCIDs(signer: Account): string[] {
    const bridgedOwnableCIDs: string[] = [];
    // TODO: enable following check
    // if (signer === undefined) {
    //   throw new UserError(
    //     'Signer is undefined. Use http authentication. See: https://docs.ltonetwork.com/libraries/javascript/http-authentication',
    //   );
    // }

    // TODO: replace 3N5vwNey9aFkyrQ5KUzMt3qfuwg5jKKzrLB with signer.address
    // const ltoUserAddress = signer.account;
    const ltoUserAddress = '3N5vwNey9aFkyrQ5KUzMt3qfuwg5jKKzrLB';
    try {
      console.log(`Fetching available request IDs for LTO user address: ${ltoUserAddress}`);
      const files = readdirSync(`${this.pathToUsers}/`);
      const myReg = new RegExp(`${ltoUserAddress}_bridged$`, 'g');
      files.forEach((file) => {
        if (file.match(myReg)) {
          const filesArray = file.split('_');
          bridgedOwnableCIDs.push(filesArray[0].toString());
        }
      });
    } catch (err) {
      console.log(err);
    }
    return bridgedOwnableCIDs;
  }
  // private async storeZip(cid: string, data: Uint8Array): Promise<void> {
  //   const file = path.join(this.path, `${cid}.zip`);
  //   await fs.writeFile(file, data);
  // }

  private async getCid(files: Map<string, Buffer>): Promise<string> {
    const source = Array.from(files.entries()).map(([filename, content]) => ({
      path: `./${filename}`,
      content,
    }));

    for await (const entry of this.ipfs.addAll(source, { onlyHash: true, cidVersion: 1, recursive: true })) {
      if (entry.path === entry.cid.toString() && !!entry.mode) return entry.cid.toString();
    }
    throw new Error('Failed to calculate directory CID: importer did not find a directory entry in the input files');
  }

  // private file(cid: string, filename?: string): string {
  //   return filename ? `${this.path}/${cid}/${filename}` : `${this.path}/${cid}.zip`;
  // }

  private async validateEventChain(chain: EventChain, verbose: boolean): Promise<void> {
    try {
      chain.validate();
      if (verbose) console.log(`eventChain.json successfully validated!`);
    } catch (e) {
      throw new UserError('Invalid event chain');
    }
    const genesisSigner = this.lto.account(chain.events[0].signKey);
    if (!chain.isCreatedBy(genesisSigner))
      throw new Error('Event chain hijacking: genesis event not signed by chain creator');
    else {
      if (verbose) console.log('All good! Genesis signer correct', genesisSigner.address);
    }

    // TODO: checking the anchoring does not work

    try {
      const { verified } = await this.ltoIndex.verifyAnchors(chain.anchorMap);
      if (!verified) throw new UserError('Chain integrity could not be verified: Mismatch in anchor map');
    } catch (err) {
      console.log('Error Verifying Anchormap', err);
    }
  }
  private validateOwnableOwnership(chain: EventChain, signer: Account, verbose: boolean): string {
    const lastEntryIndex = chain.events.length - 1;

    const { publicKey, keyType } = chain.events[0].signKey as { publicKey: Binary; keyType: 'ed25519' | 'secp256k1' };
    const account = this.lto.account({ publicKey: publicKey.base58, keyType });
    if (verbose) console.log('LTO Genesis Signer account Address', account.address);

    const lastEventSigner = this.lto.account(chain.events[lastEntryIndex].signKey);
    if (verbose) console.log('Signer of last event Entry in event Chain:', lastEventSigner.address);
    if (signer?.address?.startsWith('3') && lastEventSigner.address !== signer.address) {
      throw new AuthError(
        `Signer of last event ${lastEventSigner.address} does not match HTTP Request Signer ${signer.address}`,
      );
    } else {
      if (verbose)
        console.log('Signer of last event Entry in event Chain matches HTTP Request Signer:', lastEventSigner.address);
    }

    const lastEventChainEntry = JSON.parse(chain.events[lastEntryIndex].data.toString());
    if (!(lastEventChainEntry['@context'] === 'execute_msg.json')) {
      throw new UserError('Missing transfer context');
    } else {
      if (verbose) console.log('transfer context exists');
    }
    if (!(lastEventChainEntry.transfer.to === this.getLTOAccountAddress())) {
      throw new UserError('Bridge is not the Owner of Ownable');
    } else {
      if (verbose) console.log('Current owner of Ownable is Bridge');
    }
    return lastEventSigner.address;
  }

  public async getUnlockProof(cid: string, signer: Account): Promise<string> {
    // Must check:
    // NFT must be locked
    // CID File 'bridged' must exist (with NFT info)
    // LTO wallet must be signed in with http authentication
    // LTO wallet must match the previous ownable owner
    // TODO: enable following check for production
    // if (signer === undefined) {
    //   throw new UserError(
    //     'Signer is undefined. Use http authentication. See: https://docs.ltonetwork.com/libraries/javascript/http-authentication',
    //   );
    // }

    let cidInfoFile: string;

    try {
      console.log(`Fetching available CID: ${cid}`);
      const files = readdirSync(`${this.pathToUsers}/`);
      const myReg = new RegExp(`${cid}`, 'g');
      files.forEach((file) => {
        if (file.match(myReg)) {
          cidInfoFile = file;
        }
      });
    } catch (err) {
      console.log(err);
    }

    if (cidInfoFile === undefined) {
      throw new UserError('CID not found. Ownable with CID does not exist on server.');
    }

    const cidInfo = JSON.parse(readFileSync(`${this.pathToUsers}/${cidInfoFile}`).toString());

    console.log('cidInfo', cidInfo);

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
        const nftOwner = await this.nft.getOwnerOfNFT({
          network: cidInfo.network,
          address: cidInfo.smartContractAddress,
          id: cidInfo.NftId,
        });
        if (nftOwner.toLowerCase() !== signer.address.toLowerCase()) {
          throw new UserError(`Signer ${signer.address} is not current NFT owner ${nftOwner}`);
        }
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

  public getServerLTOwalletAddress(): string {
    return this.getLTOAccountAddress();
  }

  // async bridgeOwnable(buffer: Uint8Array, signer: Account): Promise<InfoWithProof> {
  async bridgeOwnable(buffer: Uint8Array, signer: Account, verbose: boolean): Promise<any> {
    if (verbose) console.log('unzipping Zip files into memory');
    const files = await this.unzip(buffer);
    if (!files.has('eventChain.json')) throw new Error("Invalid package: 'eventChain.json' is missing");

    const eventChainBuffer: Buffer = files.get('eventChain.json');
    if (verbose) console.log('eventChain.json found as buffer', eventChainBuffer);

    const eventChainJson: IEventChainJSON = JSON.parse(eventChainBuffer.toString());
    const chain: EventChain = EventChain.from(eventChainJson);
    if (verbose) console.log('eventChain.json imported as JSON format', chain);

    const lastEventChainEntrySigner = this.validateOwnableOwnership(chain, signer, verbose);
    await this.validateEventChain(chain, verbose);

    if (verbose) console.log('removing eventChain.json from files to create CID');
    files.delete('eventChain.json');
    const cid = await this.getCid(files);

    if (verbose) console.log('Storing Zip file without eventChain.json');
    const new_zip = new JSZip();
    await new_zip.loadAsync(buffer, { createFolders: true });
    new_zip.remove('eventChain.json');
    const content = await new_zip.generateAsync({ type: 'uint8array' });
    mkdirSync(`${this.pathToPkgs}/${cid}`, { recursive: true });
    writeFileSync(`${this.pathToPkgs}/${cid}/${cid}.zip`, content);

    await this.storeFiles(this.pathToPkgs, cid, files);

    const eventChainMap: Map<string, Buffer> = new Map().set('eventChain.json', eventChainBuffer);
    await this.storeFiles(this.pathToCids, cid, eventChainMap);

    const nftInfo: NFTInfo = JSON.parse(chain.events[0].data.toString()).nft;

    // nftInfo.network is provided by the ownable package metadata.
    // console.log('nftInfo', nftInfo);
    const proof = await this.nft.getUnlockProof(nftInfo);
    // console.log('proof', proof);

    const bridgedOwnablesInfo = {
      cid: cid.toString(),
      prevOwner: lastEventChainEntrySigner.toString(),
      network: nftInfo.network.toString(),
      smartContractAddress: nftInfo.address.toString(),
      NftId: nftInfo.id.toString(),
    };

    const signerAddress = signer?.address || lastEventChainEntrySigner.toString();

    const bridgedOwnableFile = `${this.pathToUsers}/${cid}_${signerAddress}_bridged`;
    writeFileSync(bridgedOwnableFile, JSON.stringify(bridgedOwnablesInfo));

    const nftToCidMappingFile = `${this.pathToNfts}/${bridgedOwnablesInfo.network}_${bridgedOwnablesInfo.smartContractAddress}_${bridgedOwnablesInfo.NftId}_${cid}_mapped`;
    await this.executeCommand(`touch ${nftToCidMappingFile}`);

    return {
      cid: cid.toString(),
      proof: proof.toString(),
      ltoSignerWallet: signerAddress.toString(),
      prevOwner: lastEventChainEntrySigner.toString(),
      nftNetwork: nftInfo.network.toString(),
      smartContractAddress: nftInfo.address.toString(),
      NftId: nftInfo.id.toString(),
    };
  }

  async claimOwnable(
    cid: string,
    message: string,
    signature: any,
    signer: Account,
    verbose: boolean,
  ): Promise<StreamableFile> {
    // Must check:
    // exists CID on server ?
    // NFT must be locked
    // recovered signer address from message+signature must match NFT owner address
    // Must create a claimable zip file with an updated eventChain that transfers the Ownable to the signer.address

    if (!(await this.existsCid(cid))) {
      throw new UserError('Event chain with cid ${cid} not available on this bridge');
    }

    // TODO: Uncomment the following check
    // if (signer === undefined) {
    //   throw new UserError(
    //     'Signer is undefined. Use http authentication. See: https://docs.ltonetwork.com/libraries/javascript/http-authentication',
    //   );
    // }

    // TODO: Remove this testSignature from code
    const testSignature: any = {
      r: '0xa617d0558818c7a479d5063987981b59d6e619332ef52249be8243572ef10868',
      s: '0x07e381afe644d9bb56b213f6e08374c893db308ac1a5ae2bf8b33bcddcb0f76a',
      yParity: 0,
      networkV: null,
    };

    let recoveredSignerAddressEVM: string;
    try {
      recoveredSignerAddressEVM = this.nft.verifyMessage(message, testSignature);
      if (verbose) console.log('recovered signer Address:', recoveredSignerAddressEVM);
    } catch (err) {
      throw new AuthError('Not able to verify message on Event chain with cid ${cid} not available on this bridge');
    }

    console.log('Test:', await this.nft.testSignMessage('Hello World'));

    // Transfer Ownable to signer.address and zip all together
    const chainFile = `${this.pathToCids}/${cid}/eventChain.json`;
    const eventChainJsonFile = readFileSync(chainFile, { encoding: 'utf8' });

    const data: IEventChainJSON = JSON.parse(eventChainJsonFile);
    const chain = EventChain.from(data);
    chain.validate();

    const genesisSigner = this.lto.account(chain.events[0].signKey);
    if (!chain.isCreatedBy(genesisSigner))
      throw new Error('Event chain hijacking: genesis event not signed by chain creator');
    else {
      console.log('All good! Genesis signer correct after reading EventChain from disk');
    }

    const nftInfo: NFTInfo = JSON.parse(chain.events[0].data.toString()).nft;
    const currentNftOwner = await this.nft.getOwnerOfNFT(nftInfo);

    if (currentNftOwner !== recoveredSignerAddressEVM) {
      throw new UserError(
        `Current NFT owner ${currentNftOwner} and recoveredSignerAddress on EVM chain ${recoveredSignerAddressEVM} do not match`,
      );
    }
    // TODO: 3N5vwNey9aFkyrQ5KUzMt3qfuwg5jKKzrLB must be replaced by signer.address
    const signerAddress = '3N5vwNey9aFkyrQ5KUzMt3qfuwg5jKKzrLB';
    new Event({ '@context': 'execute_msg.json', transfer: { to: signerAddress } })
      .addTo(chain)
      .signWith(this._ltoAccount);

    // TODO: add anchoring and anchoring check !
    // const appendedEvents = chain.startingWith(chain.events[0]);
    // const anchorMap1 = appendedEvents.anchorMap;
    // await this.lto.anchor(this._ltoAccount, ...anchorMap1);

    chain.validate();
    console.log('Removing previous eventChain File');
    rmSync(chainFile);
    console.log('Writing new eventChain file including the transfer event');
    writeFileSync(chainFile, JSON.stringify(chain));

    const new_zip = new JSZip();
    const zipFile = readFileSync(`${this.pathToPkgs}/${cid}/${cid}.zip`);
    const newChainFile = readFileSync(chainFile);
    await new_zip.loadAsync(zipFile, { createFolders: true });
    new_zip.file('eventChain.json', newChainFile);
    const content = await new_zip.generateAsync({ type: 'uint8array' });
    writeFileSync(`${this.pathToPkgs}/${cid}/${cid}_claimed.zip`, content);
    // const chainBuffer = Buffer.from(eventChainJsonFile, 'utf8');
    // TODO: update the NFT proof => smart contract
    const file = createReadStream(`${this.pathToPkgs}/${cid}/${cid}_claimed.zip`);
    return new StreamableFile(file);
  }

  private async executeCommand(command: string) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.log(`error: ${error.message}`);
          throw new Error(`error: ${error.message}`);
        }
        resolve(stdout ? stdout : stderr);
      });
    });
  }
  // async accept(chain: EventChain, signer: Account | undefined): Promise<InfoWithProof> {
  //   try {
  //     chain.validate();
  //   } catch (e) {
  //     throw new UserError('Invalid event chain');
  //   }

  //   const packageCid: string = chain.events[0].parsedData.package;
  //   const contract = await this.loadContract(packageCid, chain);

  //   const info = (await contract.query({ get_info: {} })) as OwnableInfo;

  //   if (this.config.get('verify.signer') && info.owner !== signer?.address) {
  //     throw new AuthError('HTTP Request is not signed by the owner of the Ownable');
  //   }

  //   if (this.config.get('verify.integrity')) {
  //     const { verified } = await this.ltoIndex.verifyAnchors(chain.anchorMap);
  //     if (!verified) throw new UserError('Chain integrity could not be verified: Mismatch in anchor map');
  //   }

  //   const isLocked = await contract.query({ is_locked: {} });
  //   if (!isLocked) throw new UserError('Ownable is not locked');

  //   // const proof = this.config.get('accept.unlockNFT') ? await this.unlock(chain, info) : undefined;
  //   const proof = this.config.get('accept.unlockNFT') ? await this.unlock(chain, info) : undefined;

  //   writeFileSync(`${this.pathToCids}/${chain.id}/${chain.id}.json`, JSON.stringify(chain));
  //   this.postToWebhook(chain, info, packageCid);

  //   return { ...info, proof };
  // }

  // async claim(chainId: string, signer: Account): Promise<Uint8Array> {
  //   const zip = await this.packages.zipped(chainId);
  //   const json = readFileSync(`${this.pathToCids}/${chainId}/${chainId}.json`, 'utf-8');

  //   // Is the signer the current owner of the Ownable? No, then return a 403

  //   zip.file(`chain.json`, json);

  //   return await zip.generateAsync({ type: 'uint8array' });
  // }
}
