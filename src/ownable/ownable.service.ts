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
import { resolveCaip2Reference } from '../common/config/evm-network.util.js';
import { NFTInfo } from '../interfaces/OwnableInfo.js';
import { NFTService } from '../nft/nft.service.js';
import { AuthError, UserError } from '../interfaces/error.js';
import JSZip from 'jszip';
import { EventChain } from 'eqty-core';
import { Readable } from 'stream';
import { ArchiveStorageService } from '../storage/archive-storage.service.js';
import { HubStateRepository, IndexedWalletEvent } from '../persistence/repos/hub-state.repository.js';

interface SignerIdentity {
  address?: string;
}

interface ReplayDerivedState {
  nftInfo: NFTInfo | null;
  ownerNetwork: string | null;
  ownerAccount: string | null;
  owner: string;
  latestAppliedPublicEventId: string | null;
}

interface AvailableOwnablePackageMetadata {
  title: string;
  description?: string;
  thumbnailUrl?: string | null;
}

interface AvailableOwnableEntry {
  id: string;
  title: string;
  description?: string;
  issuer?: string;
  availableAt: string;
  package: {
    cid: string;
    thumbnailUrl?: string | null;
  };
}

const CANONICAL_CHAIN_FILENAME = 'chain.json';
const LEGACY_CHAIN_FILENAME = 'eventChain.json';
const OWNABLE_RUNTIME_FILENAME = 'ownable_bg.wasm';
const EVM_ADDRESS_REGEX = /^0x[a-f0-9]{40}$/i;
const CAIP10_ACCOUNT_REGEX = /^([a-zA-Z0-9-]+):([a-zA-Z0-9-]+):([^:\s]+)$/;
const REQUIRED_OWNABLE_RUNTIME_EXPORTS = [
  'memory',
  'ownable_alloc',
  'ownable_free',
  'ownable_instantiate',
  'ownable_execute',
  'ownable_query',
  'ownable_register',
  'ownable_ingest',
  'ownable_encode_public_event',
] as const;
const REQUIRED_OWNABLE_RUNTIME_EXPORT_KINDS: Record<(typeof REQUIRED_OWNABLE_RUNTIME_EXPORTS)[number], WebAssembly.ImportExportKind> =
  {
    memory: 'memory',
    ownable_alloc: 'function',
    ownable_free: 'function',
    ownable_instantiate: 'function',
    ownable_execute: 'function',
    ownable_query: 'function',
    ownable_register: 'function',
    ownable_ingest: 'function',
    ownable_encode_public_event: 'function',
  };

function normalizeEvmAddress(address: string, errorMessage = 'Invalid EVM address'): string {
  const normalized = address.trim().toLowerCase();
  if (!EVM_ADDRESS_REGEX.test(normalized)) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function normalizeCaip10Account(account: string): string {
  const trimmed = account.trim();
  const match = CAIP10_ACCOUNT_REGEX.exec(trimmed);
  if (!match) {
    throw new Error('Invalid CAIP-10 account');
  }

  const namespaceRaw = match[1];
  const referenceRaw = match[2];
  const addressRaw = match[3];
  if (!namespaceRaw || !referenceRaw || !addressRaw) {
    throw new Error('Invalid CAIP-10 account');
  }

  const namespace = namespaceRaw.toLowerCase();
  const reference = referenceRaw.toLowerCase();
  const address = namespace === 'eip155' ? normalizeEvmAddress(addressRaw, 'Invalid CAIP-10 account') : addressRaw;

  return `${namespace}:${reference}:${address}`;
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

  private parseNftInfoFromOwnableInfo(info: unknown): NFTInfo | null {
    const nft = (info as { nft?: { network?: string; address?: string; id?: string | number } } | null)?.nft;
    if (!nft?.network || !nft.address || nft.id === undefined) {
      return null;
    }
    return {
      network: nft.network,
      address: nft.address,
      id: String(nft.id),
    };
  }

  private parseNftInfoFromRecord(record: {
    nftNetwork: string | null;
    nftContractAddress: string | null;
    nftTokenId: string | null;
  } | null): NFTInfo | null {
    if (!record?.nftNetwork || !record.nftContractAddress || record.nftTokenId === null) {
      return null;
    }
    return {
      network: record.nftNetwork,
      address: record.nftContractAddress,
      id: record.nftTokenId,
    };
  }

  private async deriveNftInfo(chain: EventChain, replayInfo?: unknown): Promise<NFTInfo | null> {
    try {
      return this.parseNftInfoFromChain(chain);
    } catch (error) {
      if (!(error instanceof UserError) || error.message !== 'Invalid event chain: missing NFT metadata in first event') {
        throw error;
      }
    }

    const replayNftInfo = this.parseNftInfoFromOwnableInfo(replayInfo);
    if (replayNftInfo) {
      return replayNftInfo;
    }

    const persistedNftInfo = this.parseNftInfoFromRecord(await this.hubState.getOwnableBySubjectId(chain.id));
    if (persistedNftInfo) {
      return persistedNftInfo;
    }

    return null;
  }

  private deriveOwnerNetwork(chain: EventChain, nftInfo: NFTInfo | null): string | null {
    const parsed = chain.events[0]?.parsedData as { network_id?: string | number } | undefined;
    const networkId = parsed?.network_id;
    if (typeof networkId === 'number' && Number.isInteger(networkId) && networkId > 0) {
      return `eip155:${networkId}`;
    }
    if (typeof networkId === 'string') {
      const trimmed = networkId.trim();
      if (/^\d+$/.test(trimmed)) {
        return `eip155:${trimmed}`;
      }
      if (/^eip155:\d+$/.test(trimmed)) {
        return trimmed;
      }
    }

    return nftInfo?.network ?? null;
  }

  private deriveOwnerAccount(ownerAddress: string, ownerNetwork: string | null): string | null {
    if (!ownerNetwork) {
      return null;
    }

    const reference = resolveCaip2Reference(ownerNetwork, this.config.getRuntimeNetworkProfile());
    if (!reference) {
      return null;
    }

    try {
      return normalizeCaip10Account(`eip155:${reference}:${ownerAddress}`);
    } catch {
      return null;
    }
  }

  private normalizeOwnerAccount(ownerAccount: string): string {
    const trimmedOwner = ownerAccount.trim();
    if (!trimmedOwner) {
      throw new UserError('owner is required');
    }

    try {
      return normalizeCaip10Account(trimmedOwner);
    } catch {
      throw new UserError('owner must be a valid CAIP-10 account');
    }
  }

  private deriveAvailableOwnableTitle(name: string): string {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return '';
    }

    const normalizedName = trimmedName.replace(/^ownable-/, '').replace(/-ownable$/, '');
    const words = normalizedName
      .split(/[-_]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1));

    return words.join(' ') || trimmedName;
  }

  private normalizeOptionalText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private normalizeThumbnailUrl(value: unknown): string | null | undefined {
    const candidate = this.normalizeOptionalText(value);
    if (!candidate) {
      return undefined;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'data:') {
        return parsed.toString();
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private async readAvailableOwnablePackageMetadata(cid: string): Promise<AvailableOwnablePackageMetadata> {
    const fallback = { title: cid, thumbnailUrl: null } satisfies AvailableOwnablePackageMetadata;

    try {
      const zipped = new JSZip();
      await zipped.loadAsync(await this.storage.getPackageZip(cid), { createFolders: true });
      const packageJsonFile = zipped.file('package.json');
      if (!packageJsonFile) {
        return fallback;
      }

      const packageJson = JSON.parse(await packageJsonFile.async('string')) as {
        title?: unknown;
        name?: unknown;
        description?: unknown;
        thumbnailUrl?: unknown;
        image?: unknown;
      };
      const explicitTitle = this.normalizeOptionalText(packageJson.title);
      const packageName = this.normalizeOptionalText(packageJson.name);
      const title =
        explicitTitle ?? (packageName ? this.deriveAvailableOwnableTitle(packageName) : fallback.title);

      return {
        title,
        description: this.normalizeOptionalText(packageJson.description),
        thumbnailUrl: this.normalizeThumbnailUrl(packageJson.thumbnailUrl ?? packageJson.image) ?? null,
      };
    } catch {
      return fallback;
    }
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

  private unsupportedRuntimeError(reason: string): UserError {
    return new UserError(
      `Invalid package: unsupported Ownable runtime in '${OWNABLE_RUNTIME_FILENAME}'. Expected raw-ABI exports with no wasm imports; ${reason}`,
    );
  }

  private assertSupportedOwnableRuntime(files: Map<string, Buffer>): void {
    const wasm = files.get(OWNABLE_RUNTIME_FILENAME);
    if (!wasm) {
      throw new UserError(`Invalid package: '${OWNABLE_RUNTIME_FILENAME}' is missing`);
    }

    let runtimeModule: WebAssembly.Module;
    try {
      runtimeModule = new WebAssembly.Module(Uint8Array.from(wasm));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw this.unsupportedRuntimeError(`the wasm binary could not be compiled (${detail})`);
    }

    const imports = WebAssembly.Module.imports(runtimeModule);
    if (imports.length > 0) {
      const modules = Array.from(new Set(imports.map(({ module }) => module))).join(', ');
      throw this.unsupportedRuntimeError(`found unsupported imports from module(s): ${modules}`);
    }

    const runtimeExports = WebAssembly.Module.exports(runtimeModule);
    const exportKinds = new Map(runtimeExports.map(({ name, kind }) => [name, kind]));
    const missingExports = REQUIRED_OWNABLE_RUNTIME_EXPORTS.filter((name) => !exportKinds.has(name));
    if (missingExports.length > 0) {
      throw this.unsupportedRuntimeError(`missing required raw-ABI exports: ${missingExports.join(', ')}`);
    }

    const wrongKindExports = REQUIRED_OWNABLE_RUNTIME_EXPORTS.flatMap((name) => {
      const actualKind = exportKinds.get(name);
      const expectedKind = REQUIRED_OWNABLE_RUNTIME_EXPORT_KINDS[name];
      if (actualKind === expectedKind) return [];
      return [`${name} (expected ${expectedKind}, found ${actualKind ?? 'missing'})`];
    });
    if (wrongKindExports.length > 0) {
      throw this.unsupportedRuntimeError(`wrong raw-ABI export kinds: ${wrongKindExports.join(', ')}`);
    }
  }

  private async replayOwnable(packageCid: string, eventChainBuffer: Buffer): Promise<ReplayDerivedState> {
    const chain = EventChain.from(JSON.parse(eventChainBuffer.toString('utf8')));
    this.validateEventChain(chain);

    const zipped = new JSZip();
    await zipped.loadAsync(await this.storage.getPackageZip(packageCid), { createFolders: true });
    zipped.file(CANONICAL_CHAIN_FILENAME, eventChainBuffer);
    const files = await this.unzip(await zipped.generateAsync({ type: 'uint8array' }));
    this.assertSupportedOwnableRuntime(files);

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
      title: packageCid,
      name: packageCid,
      cid: packageCid,
      isDynamic: true,
      hasMetadata: false,
      hasWidgetState: false,
      isConsumable: false,
      isConsumer: false,
      isTransferable: false,
      versions: [{ date: new Date(), cid: packageCid }],
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

    await coreOwnables.initWorker(chain.id, packageCid);
    const privateStateDump = await coreOwnables.apply(chain, []);

    const indexedRows = await this.hubState.listWalletEventsByCid(packageCid);
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

    const nftInfo = await this.deriveNftInfo(chain, info);
    coreOwnables.clearRpc(chain.id);

    return {
      nftInfo,
      ownerNetwork: this.deriveOwnerNetwork(chain, nftInfo),
      ownerAccount: this.deriveOwnerAccount(owner, this.deriveOwnerNetwork(chain, nftInfo)),
      owner,
      latestAppliedPublicEventId: latestAppliedPublicEventId ?? null,
    };
  }

  private async replayStoredOwnable(ownableId: string, packageCid: string): Promise<ReplayDerivedState> {
    const eventChainBuffer = await this.storage.getEventChain(ownableId, packageCid);
    return this.replayOwnable(packageCid, eventChainBuffer);
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
        OwnableCid: record.packageCid,
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

  async existsOwnableChain(ownableId: string, packageCid: string): Promise<boolean> {
    return await this.storage.hasEventChain(ownableId, packageCid);
  }

  async existsPkg(pkg: string): Promise<boolean> {
    return await this.storage.hasPackage(pkg);
  }

  private async unzip(data: Uint8Array): Promise<Map<string, Buffer>> {
    const zip = new JSZip();
    const archive = await zip.loadAsync(data, { createFolders: true });
    const entries: Array<[string, Buffer]> = await Promise.all(
      Object.entries(archive.files)
        .filter(([, file]) => !file.dir)
        .map(async ([filename, file]) => [filename, await file.async('nodebuffer')]),
    );
    return new Map(entries);
  }

  private resolveChainFile(files: Map<string, Buffer>): { buffer: Buffer; aliases: string[] } {
    const canonical = files.get(CANONICAL_CHAIN_FILENAME);
    const legacy = files.get(LEGACY_CHAIN_FILENAME);

    if (!canonical && !legacy) {
      throw new UserError(`Invalid package: '${CANONICAL_CHAIN_FILENAME}' or '${LEGACY_CHAIN_FILENAME}' is missing`);
    }

    if (canonical && legacy && !canonical.equals(legacy)) {
      throw new UserError(`Invalid package: '${CANONICAL_CHAIN_FILENAME}' and '${LEGACY_CHAIN_FILENAME}' differ`);
    }

    return {
      buffer: canonical ?? (legacy as Buffer),
      aliases: [CANONICAL_CHAIN_FILENAME, LEGACY_CHAIN_FILENAME].filter((filename) => files.has(filename)),
    };
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

    const replayState = await this.replayStoredOwnable(record.id, record.packageCid);
    if (!replayState.nftInfo) {
      throw new UserError('NFT metadata is unavailable for this ownable');
    }
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
    const { buffer: eventChainBuffer, aliases: chainAliases } = this.resolveChainFile(files);
    const eventChainJson = JSON.parse(eventChainBuffer.toString());
    const chain = EventChain.from(eventChainJson);
    this.validateEventChain(chain);
    this.assertSupportedOwnableRuntime(files);

    const ownerFromPrivateState = chain.events.at(-1)?.signerAddress?.toLowerCase() ?? signer?.address?.toLowerCase() ?? '';

    if (verbose) console.log(`normalizing ${chainAliases.join(', ')} into ${CANONICAL_CHAIN_FILENAME} to create CID`);
    const normalizedFiles = new Map(files);
    for (const alias of chainAliases) normalizedFiles.delete(alias);
    normalizedFiles.set(CANONICAL_CHAIN_FILENAME, eventChainBuffer);
    const cid = await this.getCid(normalizedFiles);

    const packageFiles = new Map(normalizedFiles);
    packageFiles.delete(CANONICAL_CHAIN_FILENAME);

    const newZip = new JSZip();
    await newZip.loadAsync(buffer, { createFolders: true });
    for (const alias of chainAliases) newZip.remove(alias);
    const content = await newZip.generateAsync({ type: 'uint8array' });

    await this.storage.storePackageArtifacts(cid, content, packageFiles);
    const replayState = await this.replayOwnable(cid, eventChainBuffer);
    const record = await this.hubState.upsertOwnableRecord({
      packageCid: cid,
      prevOwnerAddress: ownerFromPrivateState || '0x0000000000000000000000000000000000000000',
      subjectId: chain.id,
      nftNetwork: replayState.nftInfo?.network,
      nftContractAddress: replayState.nftInfo?.address,
      nftTokenId: replayState.nftInfo?.id,
    });
    await this.storage.storeEventChain(record.id, eventChainBuffer);
    await this.hubState.setOwnerState(record.id, replayState.owner, replayState.ownerAccount, replayState.latestAppliedPublicEventId);

    return {
      cid: cid.toString(),
      owner: replayState.owner,
      ownerAccount: replayState.ownerAccount,
      ...(replayState.nftInfo
        ? {
            nftNetwork: replayState.nftInfo.network,
            smartContractAddress: replayState.nftInfo.address,
            NftId: replayState.nftInfo.id,
          }
        : {}),
    };
  }

  async bridgeOwnable(buffer: Uint8Array, signer?: SignerIdentity, verbose = false): Promise<any> {
    return this.uploadOwnable(buffer, signer, verbose);
  }

  async downloadOwnable(cid: string): Promise<StreamableFile> {
    const record = await this.hubState.getOwnableByCid(cid);
    if (!record) throw new UserError(`Event chain with cid ${cid} not available on this hub`);
    if (!(await this.existsOwnableChain(record.id, record.packageCid))) throw new UserError(`Event chain with cid ${cid} not available on this hub`);
    if (!(await this.existsPkg(cid))) throw new UserError(`Ownable package with cid ${cid} not available on this hub`);

    await this.replayStoredOwnable(record.id, record.packageCid);

    const zipped = new JSZip();
    const zipFile = await this.storage.getPackageZip(cid);
    await zipped.loadAsync(zipFile, { createFolders: true });
    zipped.remove(LEGACY_CHAIN_FILENAME);
    zipped.file(CANONICAL_CHAIN_FILENAME, await this.storage.getEventChain(record.id, record.packageCid));

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

  async downloadOwnableChain(ownableId: string): Promise<Buffer> {
    const record = await this.hubState.getOwnableBySubjectId(ownableId);
    if (!record) throw new UserError(`Ownable chain with id ${ownableId} not available on this hub`);
    if (!(await this.existsOwnableChain(record.id, record.packageCid))) {
      throw new UserError(`Ownable chain with id ${ownableId} not available on this hub`);
    }
    return await this.storage.getEventChain(record.id, record.packageCid);
  }

  async getAvailableOwnables(ownerAccount: string): Promise<{
    owner: string;
    entries: AvailableOwnableEntry[];
  }> {
    if (!this.config.isLocalDevRecipientDiscoveryEnabled()) {
      throw new UserError('RECIPIENT_DISCOVERY_DISABLED');
    }

    const normalizedOwnerAccount = this.normalizeOwnerAccount(ownerAccount);
    const rows = await this.hubState.listAvailableOwnablesByOwnerAccount(normalizedOwnerAccount);
    const entries = await Promise.all(
      rows.map(async (row): Promise<AvailableOwnableEntry> => {
        const metadata = await this.readAvailableOwnablePackageMetadata(row.packageCid);
        return {
          id: row.subjectId ?? row.ownableId,
          title: metadata.title,
          ...(metadata.description ? { description: metadata.description } : {}),
          ...(row.issuerAddress ? { issuer: row.issuerAddress } : {}),
          availableAt: row.availableAt,
          package: {
            cid: row.packageCid,
            thumbnailUrl: metadata.thumbnailUrl ?? null,
          },
        };
      }),
    );

    return {
      owner: normalizedOwnerAccount,
      entries,
    };
  }
}
