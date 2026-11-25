import JSZip from 'jszip';
import { Readable } from 'stream';
import { ethers } from 'ethers';
import { Event, EventChain } from '../test-mocks/eqty-core';
import { OwnableService } from './ownable.service';
import {
  AnchorValidationService,
  ConsumptionEvidencePendingError,
  PublicEventReplayService,
  OwnableService as CoreOwnableService,
} from '@ownables/core';
import { firstValueFrom, Subject } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { calculateOwnablePackageCid } from '@ownables/core/utils';

const PRIVATE_STATE_OWNER_WALLET = ethers.Wallet.createRandom();
const REPLAY_OWNER_WALLET = ethers.Wallet.createRandom();
const DEFAULT_ANCHORS = [{ key: { hex: '0xanchor' }, value: { hex: '0xbbb' } }];
const ACTIVE_LIVE_IDENTITY = {
  slotName: 'testnet',
  chainId: '84532',
  anchorContractAddress: '0x0000000000000000000000000000000000000001',
};
const BASE_SEPOLIA_NETWORK = {
  slug: 'base-sepolia',
  caip2: 'eip155:84532',
  chainId: '84532',
  slotName: 'testnet',
  rpcUrl: 'https://sepolia.base.org',
  anchorContractAddress: ACTIVE_LIVE_IDENTITY.anchorContractAddress,
  anchorStartBlock: 1n,
} as const;
const BASE_NETWORK = {
  slug: 'base',
  caip2: 'eip155:8453',
  chainId: '8453',
  slotName: 'mainnet',
  rpcUrl: 'https://mainnet.base.org',
  anchorContractAddress: '0x0000000000000000000000000000000000000002',
  anchorStartBlock: 1n,
} as const;
let mockReplayInfo: Record<string, unknown>;
let mockReplayFailure: Error | null;
const mockClearRpc = jest.fn();
const mockConsumptionReplay = jest.fn();

jest.mock('eqty-core', () => require('../test-mocks/eqty-core.ts'));
jest.mock('@ownables/core/utils', () => ({
  OWNABLE_ATTACHMENT_PREFIX: 'attachments/',
  splitOwnableArchiveEntries: (entries: Iterable<[string, Uint8Array]>) => {
    const assets = new Map();
    const attachments = new Map();
    let chain: Uint8Array | undefined;
    for (const [path, bytes] of entries) {
      if (path === 'chain.json' || path === 'eventChain.json') chain = bytes;
      else if (path.startsWith('attachments/')) attachments.set(path.slice('attachments/'.length), bytes);
      else assets.set(path, bytes);
    }
    return { assets, chain, attachments };
  },
  collectOwnableAttachments: async (chain: EventChain, read: (cid: string) => Promise<Uint8Array | undefined>) => {
    const attachments = new Map();
    for (const event of chain.events) {
      const cid = event.parsedData.source?.cid;
      if (!cid) continue;
      const bytes = await read(cid);
      if (!bytes) throw new Error('Missing consumption attachment');
      attachments.set(cid, bytes);
    }
    return attachments;
  },
  serializeOwnableChain: (chain: EventChain) => chain.toJSON(),
  calculateOwnablePackageCid: (entries: Array<{ path: string; content?: Uint8Array | Buffer }>) =>
    `cid-${entries
      .map((entry) => `${entry.path}:${Buffer.from(entry.content ?? []).toString('hex')}`)
      .sort()
      .join('-')}`,
}));
jest.mock('@ownables/core', () => {
  const validateAnchorsAgainstIndexedRecords = (
    anchors: Array<{ key: { hex: string }; value: { hex: string } }>,
    indexedRecords: Array<{
      key: string;
      value: string;
      transactionHash?: string;
      blockNumber?: number;
      transactionIndex?: number;
      logIndex?: number;
    }>,
  ) => {
    const latestByKey = new Map<string, (typeof indexedRecords)[number]>();
    for (const record of indexedRecords) {
      latestByKey.set(record.key.toLowerCase(), record);
    }

    const details = Object.fromEntries(
      anchors.map(({ key, value }) => {
        const evidence = latestByKey.get(key.hex.toLowerCase());
        const actualValue = evidence?.value?.toLowerCase() ?? value.hex.toLowerCase();
        const verified = Boolean(evidence?.transactionHash) && actualValue === value.hex.toLowerCase();
        return [
          key.hex,
          {
            key: key.hex,
            expectedValue: value.hex.toLowerCase(),
            value: actualValue,
            verified,
            source: evidence ? 'indexed' : 'provider',
            ...(evidence?.transactionHash ? { transactionHash: evidence.transactionHash } : {}),
            ...(evidence?.blockNumber !== undefined ? { blockNumber: evidence.blockNumber } : {}),
            ...(evidence?.transactionIndex !== undefined ? { transactionIndex: evidence.transactionIndex } : {}),
            ...(evidence?.logIndex !== undefined ? { logIndex: evidence.logIndex } : {}),
          },
        ];
      }),
    );

    return {
      verified:
        anchors.length > 0 && Object.values(details).every((detail) => detail.verified && detail.transactionHash),
      anchors: Object.fromEntries(
        anchors.map(({ key }) => [key.hex, details[key.hex]?.transactionHash as string | undefined]),
      ),
      map: Object.fromEntries(anchors.map(({ key }) => [key.hex, details[key.hex]?.value ?? ''])),
      details,
    };
  };

  class MockCoreEventChainService {
    constructor(
      private readonly _stateStore: any,
      private readonly _anchorProvider: any,
      private readonly anchorValidation?: { validateAgainstIndexedRecords: (anchors: any[], records: any[]) => any },
    ) {}
    async verify(chain: any, anchorEvidence?: { indexedRecords: any[] }) {
      if (!anchorEvidence) throw new Error('AnchorValidationService source is not configured');
      return this.anchorValidation?.validateAgainstIndexedRecords(chain.anchorMap ?? [], anchorEvidence.indexedRecords);
    }
  }

  class MockCoreOwnableService {
    private readonly rpcStore = new Map<string, any>();
    static hasConsumptionClaims(chain: EventChain) {
      return MockCoreOwnableService.hasBoundConsumptionClaims(chain)
        || chain.events.some((event) => event.parsedData.eventType === 'consume');
    }
    static hasBoundConsumptionClaims(chain: EventChain) {
      return chain.events.some((event) => event.parsedData.type === 'consume');
    }
    constructor(..._args: any[]) {}
    async initWorker(id: string, _cid: string) {
      this.rpcStore.set(id, {
        query: async () => mockReplayInfo,
      });
    }
    async apply(_chain: any, _state: any[]) {
      if (mockReplayFailure) throw mockReplayFailure;
      return [];
    }
    async replayConsumptionChain(chain: EventChain, options: unknown) {
      return mockConsumptionReplay(chain, options);
    }
    async attemptReplayIndexedPublicEvents(_chainId: string, stateDump: any[], indexedPublicEvents: any[]) {
      const firstReject = indexedPublicEvents.find((event) => event.eventType === 'reject');
      if (firstReject) {
        return {
          complete: true,
          stateDump,
          appliedEvents: [],
          appliedReplayKeys: [],
          duplicateReplayKeys: [],
          appliedPublicEvents: [],
          duplicatePublicEvents: [],
          ignoredPublicEvents: [
            {
              replayKey: `${firstReject.transactionHash}:${firstReject.logIndex}`,
              event: firstReject,
              reason: 'register_failed',
              cause: new Error('reject'),
            },
          ],
        };
      }
      return {
        complete: true,
        stateDump,
        appliedEvents: indexedPublicEvents,
        appliedReplayKeys: indexedPublicEvents.map((event) => `${event.transactionHash}:${event.logIndex}`),
        duplicateReplayKeys: [],
        appliedPublicEvents: indexedPublicEvents.map((event) => ({
          replayKey: `${event.transactionHash}:${event.logIndex}`,
          event,
        })),
        duplicatePublicEvents: [],
        ignoredPublicEvents: [],
      };
    }
    rpc(id: string) {
      return this.rpcStore.get(id);
    }
    clearRpc(id: string) {
      mockClearRpc(id);
    }
  }

  return {
    ConsumptionEvidencePendingError: class extends Error {},
    evaluateReplayFreshness: (events: any[], appliedReplayKeys: string[]) => {
      const keys = events.map((event) => `${event.transactionHash}:${event.logIndex}`);
      const missingReplayKeys = keys.filter((key) => !appliedReplayKeys.includes(key));
      return { stale: missingReplayKeys.length > 0, missingReplayKeys };
    },
    publicEventReplayKey: (event: any) => `${event.transactionHash}:${event.logIndex}`,
    validateAnchorsAgainstIndexedRecords,
    AnchorValidationService: class {
      validateAgainstIndexedRecords(anchors: any[], records: any[]) {
        return validateAnchorsAgainstIndexedRecords(anchors, records);
      }
    },
    PublicEventReplayService: class {
      key(event: any) {
        return `${event.transactionHash}:${event.logIndex}`;
      }
      evaluateFreshness(events: any[], applied: string[]) {
        const missingReplayKeys = events.map((event) => this.key(event)).filter((key) => !applied.includes(key));
        return { stale: missingReplayKeys.length > 0, missingReplayKeys };
      }
    },
    OwnableService: MockCoreOwnableService,
    EventChainService: MockCoreEventChainService,
  };
});

jest.mock('@ownables/platform-node', () => {
  class MockNodeSandboxOwnableRPC {
    private owner = '0x0000000000000000000000000000000000000000';

    async initialize() {}

    terminate() {}

    setWidgetWindow() {}

    async instantiate(_msg: any, info: { sender: string }) {
      this.owner = String(info.sender).toLowerCase();
      return { attributes: {}, state: [['owner', this.owner]] };
    }

    async execute(_msg: any, _info: any, state: any[]) {
      return { attributes: {}, events: [], data: '', state };
    }

    async register(event: { eventType: string }, _info: any, state: any[]) {
      if (event.eventType === 'reject') throw new Error('reject-event');
      return { attributes: {}, events: [], data: '', state };
    }

    async ingest(_event: any, _info: any, state: any[]) {
      return { attributes: {}, events: [], data: '', state };
    }

    async encodePublicEvent(_eventType: string, payload: Uint8Array) {
      return payload;
    }

    async query(_msg: any) {
      return { owner: this.owner };
    }

    async refresh() {}
  }

  class MockNodePackageAssetIO {
    constructor(private readonly options: any) {}

    info(nameOrCid: string) {
      return this.options.infoResolver(nameOrCid);
    }

    async getAsset(_cid: string, name: string, read: (reader: any, contents: any) => void) {
      const contents = await this.options.assetLoader(_cid, name);
      const reader = {
        result: null as any,
        readAsArrayBuffer: (value: Buffer) => {
          reader.result = Uint8Array.from(value).buffer;
        },
      };
      read(reader, contents);
      return reader.result;
    }

    async getAssetAsText(_cid: string, name: string) {
      const contents = await this.options.assetLoader(_cid, name);
      return Buffer.from(contents).toString('utf8');
    }

    async zip() {
      throw new Error('not used');
    }
  }

  return {
    NodeSandboxOwnableRPC: MockNodeSandboxOwnableRPC,
    NodePackageAssetIO: MockNodePackageAssetIO,
    NodeRuntimeSourceProvider: class {},
    NodeRuntimeRpcProvider: class {},
  };
});

describe('OwnableService', () => {
  beforeEach(() => {
    mockClearRpc.mockReset();
    mockConsumptionReplay.mockReset();
    mockReplayFailure = null;
    mockReplayInfo = {
      owner: REPLAY_OWNER_WALLET.address.toLowerCase(),
    };
  });

  const buildConfig = () => ({
    getAuthoritySignerPrivateKey: () => '',
    getAuthoritySignerMnemonic: () => PRIVATE_STATE_OWNER_WALLET.mnemonic?.phrase || '',
    getAppConfig: () => ({ publicBaseUrl: 'http://127.0.0.1:8000' }),
    isLocalDevRecipientDiscoveryEnabled: () => true,
    resolveHubNetwork: (network: string) => {
      if (network === 'base-sepolia') return BASE_SEPOLIA_NETWORK;
      if (network === 'base') return BASE_NETWORK;
      throw new Error(`Unsupported Hub network: ${network}`);
    },
  });

  const buildService = async () => {
    let stagedContents = Buffer.alloc(0);
    const storage = {
      storePackageArtifacts: jest.fn().mockResolvedValue(undefined),
      storeEventChain: jest.fn().mockResolvedValue(undefined),
      storeImmutableEventChain: jest.fn().mockResolvedValue('archives/chains/ownable/chain.json'),
      storeEventChainAttachments: jest.fn().mockResolvedValue(undefined),
      hasEventChain: jest.fn().mockResolvedValue(true),
      hasPackage: jest.fn().mockResolvedValue(true),
      getEventChain: jest.fn(),
      getEventChainAttachments: jest.fn().mockResolvedValue(undefined),
      getPackageZip: jest.fn(),
    };
    const hubState = {
      upsertOwnableRecord: jest.fn().mockResolvedValue({ id: 'id-1' }),
      setOwnerState: jest.fn().mockResolvedValue(undefined),
      publishQuarantinedUpload: jest.fn().mockResolvedValue({ recordId: 'id-1', ownerAccount: null, ownerStateVersion: 1 }),
      getOwnerStateByCid: jest.fn().mockResolvedValue({
        owner: REPLAY_OWNER_WALLET.address.toLowerCase(),
        version: 1,
        latestAppliedPublicEventId: null,
      }),
      getOwnableByCid: jest.fn().mockResolvedValue({ id: 'id-1', packageCid: 'cid-1' }),
      getOwnableBySubjectId: jest.fn().mockResolvedValue(null),
      listAvailableOwnablesByOwnerAccount: jest.fn().mockResolvedValue([]),
      listOwnableCidsByPrevOwner: jest.fn().mockResolvedValue(['cid-a']),
      listWalletEventsByCid: jest.fn().mockResolvedValue([]),
      listIndexedAnchorEventsByAnchorKeys: jest.fn().mockResolvedValue([
        {
          transactionHash: '0xaaa',
          blockNumber: '10',
          transactionIndex: 0,
          logIndex: 0,
          ownerAddress: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase(),
          payloadJson: { key: '0xanchor', value: '0xbbb' },
        },
      ]),
      listIndexedPublicEventsBySubjectId: jest.fn().mockResolvedValue([]),
      listIndexedPublicEventsBySubjectIdsAfter: jest.fn().mockResolvedValue([]),
    };
    const ownableTransport = {
      publishPublicEvent: jest.fn(),
      watchPublicEvents: jest.fn(),
      publishAvailableOwnable: jest.fn(),
      watchAvailableOwnables: jest.fn(),
    };
    const quarantine = {
      digest: jest.fn(() => 'upload-digest'),
      findExactRetry: jest.fn().mockResolvedValue({ pending: null, available: null }),
      acquireProcessing: jest.fn().mockResolvedValue(async () => undefined),
      stage: jest.fn(async (input, contents) => {
        stagedContents = Buffer.from(contents);
        return {
          id: 'quarantine-1',
          ...input,
          status: 'pending',
          expiresAt: '2026-11-03T00:00:00.000Z',
          promotionLeaseOwner: null,
          promotionLeaseExpiresAt: null,
          reasonCode: null,
          reasonDetail: null,
          createdAt: '2026-11-02T00:00:00.000Z',
          privateObjectKey: 'quarantine/uploads/upload-digest.zip',
        };
      }),
      claim: jest.fn(async () => ({
        id: 'quarantine-1',
        ownableId: '',
        subjectId: '',
        packageCid: '',
        uploadDigest: '',
        compressedBytes: '0',
        expandedBytes: '0',
        privateObjectKey: 'quarantine/uploads/upload-digest.zip',
        eventChainDigest: '',
        previousOwnerAddress: '',
        status: 'promoting',
        expiresAt: '2026-11-03T00:00:00.000Z',
        promotionLeaseOwner: null,
        promotionLeaseExpiresAt: null,
        reasonCode: null,
        reasonDetail: null,
        createdAt: '2026-11-02T00:00:00.000Z',
      })),
      load: jest.fn(async () => stagedContents),
      defer: jest.fn(),
      reject: jest.fn(),
      cleanup: jest.fn(),
      cleanupPrivateObject: jest.fn(),
      claimForPromotion: jest.fn().mockResolvedValue([]),
    };
    quarantine.claim.mockImplementation(async () => {
      const [input] = quarantine.stage.mock.calls.at(-1) ?? [];
      return { ...input, id: 'quarantine-1', status: 'promoting', expiresAt: '2026-11-03T00:00:00.000Z' };
    });
    const service = new OwnableService(
      buildConfig() as any,
      storage as any,
      hubState as any,
      ownableTransport as any,
      {
        validateAnchors: (anchors: any[], records: any[]) =>
          new AnchorValidationService().validateAgainstIndexedRecords(anchors, records),
        freshness: (events: any[], applied: Iterable<string>, ignored: Set<string>) =>
          new PublicEventReplayService().evaluateFreshness(
            events.filter((event) => !ignored.has(`${event.transactionHash}:${event.logIndex}`)),
            Array.from(applied),
          ),
        createRuntime: jest.fn((stateStore, anchorProvider) => ({
          eventChains: new (jest.requireMock('@ownables/core').EventChainService)(
            stateStore,
            anchorProvider,
            new AnchorValidationService(),
          ),
          ownables: new (jest.requireMock('@ownables/core').OwnableService)(),
        })),
      } as any,
      quarantine as any,
    );
    const runtimeValidatorSpy = jest
      .spyOn(service as any, 'assertSupportedOwnableRuntime')
      .mockImplementation(() => undefined);

    return { service, storage, hubState, ownableTransport, quarantine, runtimeValidatorSpy };
  };

  const createChain = async (
    networkId: string | number = 84532,
    anchors: Array<{ key: { hex: string }; value: { hex: string } }> = DEFAULT_ANCHORS,
  ) => {
    const chain = new EventChain(`0x${'11'.repeat(32)}`);
    const signer = {
      getAddress: async () => PRIVATE_STATE_OWNER_WALLET.address,
      signTypedData: async () => `0x${'00'.repeat(65)}`,
    };
    const event = new Event({ '@context': 'instantiate_msg.json', network_id: networkId, anchors });
    event.previous = {
      toHex: () => `0x${'12'.repeat(32)}`,
    } as any;
    await event.addTo(chain).signWith(signer);
    return chain;
  };

  const createSdkIssuedChain = async () => {
    const chain = new EventChain(`0x${'11'.repeat(32)}`);
    const signer = {
      getAddress: async () => PRIVATE_STATE_OWNER_WALLET.address,
      signTypedData: async () => `0x${'00'.repeat(65)}`,
    };
    const event = new Event({
      '@context': 'instantiate_msg.json',
      ownable_id: chain.id,
      package: 'cid-package',
      network_id: 84532,
      keywords: [],
      anchors: DEFAULT_ANCHORS,
    });
    await event.addTo(chain).signWith(signer);
    return chain;
  };

  const expectedSubjectId = (ownableId: string) => ethers.keccak256(ethers.getBytes(ownableId)).toLowerCase();

  const toBuffer = async (stream: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    return Buffer.concat(chunks);
  };

  const createUploadBuffer = async (
    chain: EventChain,
    filenames: string[] = ['chain.json'],
    overrides: Record<string, string> = {},
    runtimeWasm: Buffer | Uint8Array = Buffer.from([0x00]),
  ) => {
    const zip = new JSZip();
    const chainJson = JSON.stringify(chain.toJSON());
    for (const filename of filenames) {
      zip.file(filename, overrides[filename] ?? chainJson);
    }
    zip.file('package.json', JSON.stringify({ name: 'test' }));
    zip.file('ownable_bg.wasm', runtimeWasm);
    return zip.generateAsync({ type: 'uint8array' });
  };

  const buildWrongKindRuntimeWasm = (): Uint8Array => {
    const encodeU32 = (value: number): number[] => {
      const bytes: number[] = [];
      let remaining = value >>> 0;
      do {
        let byte = remaining & 0x7f;
        remaining >>>= 7;
        if (remaining > 0) byte |= 0x80;
        bytes.push(byte);
      } while (remaining > 0);
      return bytes;
    };

    const encodeString = (value: string): number[] => {
      const bytes = Array.from(Buffer.from(value, 'utf8'));
      return [...encodeU32(bytes.length), ...bytes];
    };

    const section = (id: number, contents: number[]): number[] => [id, ...encodeU32(contents.length), ...contents];

    const typeSection = section(1, [
      ...encodeU32(3),
      0x60,
      ...encodeU32(1),
      0x7f,
      ...encodeU32(1),
      0x7f,
      0x60,
      ...encodeU32(2),
      0x7f,
      0x7f,
      ...encodeU32(0),
      0x60,
      ...encodeU32(2),
      0x7f,
      0x7f,
      ...encodeU32(1),
      0x7e,
    ]);

    const functionSection = section(3, [
      ...encodeU32(8),
      ...encodeU32(0),
      ...encodeU32(1),
      ...encodeU32(2),
      ...encodeU32(2),
      ...encodeU32(2),
      ...encodeU32(2),
      ...encodeU32(2),
      ...encodeU32(2),
    ]);

    const globalSection = section(6, [...encodeU32(1), 0x7f, 0x00, 0x41, 0x00, 0x0b]);

    const exportEntries: Array<[string, number, number]> = [
      ['memory', 0x03, 0],
      ['ownable_alloc', 0x00, 0],
      ['ownable_free', 0x00, 1],
      ['ownable_instantiate', 0x00, 2],
      ['ownable_execute', 0x00, 3],
      ['ownable_query', 0x00, 4],
      ['ownable_register', 0x00, 5],
      ['ownable_ingest', 0x00, 6],
      ['ownable_encode_public_event', 0x00, 7],
    ];
    const exportSection = section(7, [
      ...encodeU32(exportEntries.length),
      ...exportEntries.flatMap(([name, kind, index]) => [...encodeString(name), kind, ...encodeU32(index)]),
    ]);

    const functionBodies = [
      [0x00, 0x20, 0x00, 0x0b],
      [0x00, 0x0b],
      [0x00, 0x42, 0x00, 0x0b],
      [0x00, 0x42, 0x00, 0x0b],
      [0x00, 0x42, 0x00, 0x0b],
      [0x00, 0x42, 0x00, 0x0b],
      [0x00, 0x42, 0x00, 0x0b],
      [0x00, 0x42, 0x00, 0x0b],
    ];
    const codeSection = section(10, [
      ...encodeU32(functionBodies.length),
      ...functionBodies.flatMap((body) => [...encodeU32(body.length), ...body]),
    ]);

    return Uint8Array.from([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      ...typeSection,
      ...functionSection,
      ...globalSection,
      ...exportSection,
      ...codeSection,
    ]);
  };

  const buildWasmBindgenRuntimeWasm = (): Uint8Array =>
    Uint8Array.from([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x04,
      0x01,
      0x60,
      0x00,
      0x00,
      0x02,
      0x09,
      0x01,
      0x03,
      0x77,
      0x62,
      0x67,
      0x01,
      0x78,
      0x00,
      0x00,
    ]);

  it('accepts upload by passing indexed anchor evidence through EventChainService verification', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
    const buffer = await createUploadBuffer(chain);
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    packageZip.file('package.json', JSON.stringify({ name: 'test' }));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));

    const result = await service.uploadOwnable(buffer, BASE_SEPOLIA_NETWORK, undefined, false);

    expect(result.cid).toEqual(expect.any(String));
    expect(result.ownerAccount).toEqual(`eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`);
    expect(result).not.toHaveProperty('nftNetwork');
    expect(result).not.toHaveProperty('smartContractAddress');
    expect(result).not.toHaveProperty('NftId');
    expect(storage.storePackageArtifacts).toHaveBeenCalledTimes(1);
    expect(storage.storeImmutableEventChain).toHaveBeenCalledTimes(1);
    expect(hubState.publishQuarantinedUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        ownableId: chain.id,
        owner: REPLAY_OWNER_WALLET.address.toLowerCase(),
        ownerAccount: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
      }),
    );
    expect(hubState.upsertOwnableRecord).not.toHaveBeenCalled();
    expect(hubState.setOwnerState).not.toHaveBeenCalled();
    expect(storage.storeEventChain).not.toHaveBeenCalled();
    expect(mockClearRpc).toHaveBeenCalledWith(chain.id);
  });

  it('holds a consumer until its source anchor is indexed and distributes only that revision’s proof bytes', async () => {
    const { service, storage, hubState, quarantine } = await buildService();
    const chain = await createChain();
    const sourceAnchor = { key: { hex: '0xsource' }, value: { hex: '0xconsume' } };
    const sourceChain = await createChain(84532, [sourceAnchor]);
    const cid = `b${'a'.repeat(58)}`;
    const proof = Buffer.from([0x50, 0x4b, 0x00, 0xff]);
    const signer = {
      getAddress: async () => PRIVATE_STATE_OWNER_WALLET.address,
      signTypedData: async () => `0x${'00'.repeat(65)}`,
    };
    chain.events[0].parsedData.package = await calculateOwnablePackageCid([
      { path: 'package.json', content: Buffer.from(JSON.stringify({ name: 'test' })) },
      { path: 'ownable_bg.wasm', content: Buffer.from([0x00]) },
    ]);
    await new Event({ '@context': 'ingest_msg.json', type: 'consume', source: { cid } }).addTo(chain).signWith(signer);
    const archive = await JSZip.loadAsync(await createUploadBuffer(chain));
    archive.file(`attachments/${cid}`, proof);

    const indexed = (anchor, transactionHash, identity = ACTIVE_LIVE_IDENTITY) => ({
      ...identity,
      transactionHash,
      blockNumber: '10',
      transactionIndex: 0,
      logIndex: 0,
      ownerAddress: PRIVATE_STATE_OWNER_WALLET.address,
      payloadJson: { key: anchor.key.hex, value: anchor.value.hex },
    });
    const wrongDeployment = { ...ACTIVE_LIVE_IDENTITY, anchorContractAddress: ethers.ZeroAddress };
    const rootAnchor = indexed(DEFAULT_ANCHORS[0], '0xroot');
    const ignoredSourceAnchor = indexed(sourceAnchor, '0xignored', wrongDeployment);
    const acceptedSourceAnchor = indexed(sourceAnchor, '0xsource-transaction');
    hubState.listIndexedAnchorEventsByAnchorKeys.mockImplementation(async (keys: string[]) =>
      keys.includes(sourceAnchor.key.hex) ? [ignoredSourceAnchor] : [rootAnchor],
    );
    mockConsumptionReplay.mockImplementation(async (root, options) => {
      expect(await options.getAttachment(cid)).toEqual(proof);
      const [rootEvidence, sourceEvidence] = await Promise.all([
        options.verifyAnchors(root),
        options.verifyAnchors(sourceChain),
      ]);
      expect(rootEvidence.verified).toBe(true);
      const transaction = sourceEvidence.anchors[sourceAnchor.key.hex];
      expect(transaction).not.toBe('0xignored');
      if (!sourceEvidence.verified) throw new ConsumptionEvidencePendingError('Missing public event checkpoint');
      return { stateDump: [], verified: true, appliedPublicReplayKeys: [] };
    });

    const upload = await service.uploadOwnable(await archive.generateAsync({ type: 'uint8array' }), BASE_SEPOLIA_NETWORK);
    expect(upload.status).toBe('pending');
    expect(storage.storeEventChainAttachments).not.toHaveBeenCalled();
    expect(hubState.publishQuarantinedUpload).not.toHaveBeenCalled();

    quarantine.claimForPromotion.mockResolvedValue([await quarantine.claim()]);
    await service.promoteQuarantinedUploads();
    expect(quarantine.defer).toHaveBeenCalledWith('quarantine-1');
    expect(quarantine.reject).not.toHaveBeenCalled();

    hubState.listIndexedAnchorEventsByAnchorKeys.mockImplementation(async (keys: string[]) =>
      keys.includes(sourceAnchor.key.hex) ? [ignoredSourceAnchor, acceptedSourceAnchor] : [rootAnchor],
    );
    await service.promoteQuarantinedUploads();

    expect(hubState.publishQuarantinedUpload).toHaveBeenCalled();
    const [staticCid, staticBytes, staticFiles] = storage.storePackageArtifacts.mock.calls[0];
    expect(staticCid).toBe(chain.events[0].parsedData.package);
    expect(staticFiles.has(`attachments/${cid}`)).toBe(false);
    expect((await JSZip.loadAsync(staticBytes)).file(`attachments/${cid}`)).toBeNull();
    const [key, sidecar] = storage.storeEventChainAttachments.mock.calls[0];
    expect(await (await JSZip.loadAsync(sidecar)).file(`attachments/${cid}`).async('nodebuffer')).toEqual(proof);

    hubState.getOwnableBySubjectId.mockResolvedValue({ id: chain.id, packageCid: staticCid, chainStorageKey: key });
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON())));
    storage.getPackageZip.mockResolvedValue(staticBytes);
    storage.getEventChainAttachments.mockResolvedValue(sidecar);
    const bundle = await service.downloadOwnable(chain.id, BASE_SEPOLIA_NETWORK);
    const downloaded = await JSZip.loadAsync(await toBuffer(bundle.getStream() as Readable));
    expect(await downloaded.file(`attachments/${cid}`).async('nodebuffer')).toEqual(proof);
    expect(storage.getEventChainAttachments).toHaveBeenCalledWith(key);
  });

  it('serves available legacy consume history as unverified and rejects a fresh upload without proof', async () => {
    const { service, storage, hubState, quarantine } = await buildService();
    const chain = await createChain();
    await new Event({ '@context': 'ingest_msg.json', eventType: 'consume', attributes: {} }).addTo(chain).signWith({
      getAddress: async () => PRIVATE_STATE_OWNER_WALLET.address,
      signTypedData: async () => `0x${'00'.repeat(65)}`,
    });
    const upload = await createUploadBuffer(chain);
    await expect(service.uploadOwnable(upload, BASE_SEPOLIA_NETWORK)).rejects.toThrow('Historical consume event has no verification proof');
    expect(quarantine.stage).not.toHaveBeenCalled();

    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: chain.id, packageCid: 'cid-1' });
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON())));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    const verification = await service.getOwnableVerification(chain.id, BASE_SEPOLIA_NETWORK);
    expect(verification.verified).toBe(false);
    expect(verification.anchorVerification.verified).toBe(true);
    const bundle = await service.downloadOwnable(chain.id, BASE_SEPOLIA_NETWORK);
    const downloaded = await JSZip.loadAsync(await toBuffer(bundle.getStream() as Readable));
    expect(JSON.parse(await downloaded.file('chain.json').async('string')).events.at(-1).parsedData.eventType).toBe('consume');
  });

  it('clears the archive-scoped RPC when replay fails after worker initialization', async () => {
    const { service } = await buildService();
    const chain = await createChain();
    const buffer = await createUploadBuffer(chain);
    mockReplayFailure = new Error('replay failed');

    await expect(service.uploadOwnable(buffer, BASE_SEPOLIA_NETWORK, undefined, false)).rejects.toThrow('replay failed');

    expect(mockClearRpc).toHaveBeenCalledWith(chain.id);
  });

  it('derives the owner account from the first event network_id', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createSdkIssuedChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
    const buffer = await createUploadBuffer(chain);
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    packageZip.file('package.json', JSON.stringify({ name: 'test' }));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    mockReplayInfo = { owner: REPLAY_OWNER_WALLET.address.toLowerCase() };

    const result = await service.uploadOwnable(buffer, BASE_SEPOLIA_NETWORK, undefined, false);

    expect(result.owner).toEqual(REPLAY_OWNER_WALLET.address.toLowerCase());
    expect(result.ownerAccount).toEqual(`eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`);
    expect(result).not.toHaveProperty('nftNetwork');
    expect(result).not.toHaveProperty('smartContractAddress');
    expect(result).not.toHaveProperty('NftId');
    expect(hubState.publishQuarantinedUpload).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: expectedSubjectId(chain.id) }),
    );
  });

  it.each([undefined, 0, -1, 1.5, '', '0', '84532.5', 'eip155:0', 'cosmos:84532', ' eip155:84532'])(
    'rejects upload without a valid first-event network_id: %p',
    async (networkId) => {
      const { service, storage, hubState } = await buildService();
      const chain = await createChain();
      chain.events[0].parsedData.network_id = networkId;

      await expect(service.uploadOwnable(await createUploadBuffer(chain), BASE_SEPOLIA_NETWORK, undefined, false)).rejects.toThrow(
        'Invalid event chain: invalid network_id in first event',
      );

      expect(hubState.publishQuarantinedUpload).not.toHaveBeenCalled();
      expect(storage.storePackageArtifacts).not.toHaveBeenCalled();
      expect(storage.storeImmutableEventChain).not.toHaveBeenCalled();
    },
  );

  it.each(['84532', 'eip155:84532'])('accepts the supported first-event network_id shape: %s', async (networkId) => {
    const { service } = await buildService();
    const chain = await createChain(networkId);

    await expect(service.uploadOwnable(await createUploadBuffer(chain), BASE_SEPOLIA_NETWORK, undefined, false)).resolves.toEqual(
      expect.objectContaining({
        ownerAccount: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
      }),
    );
  });

  it('rejects a mismatched upload network before retry lookup or quarantine staging', async () => {
    const { service, hubState, quarantine, storage } = await buildService();
    const chain = await createChain(8453);
    const leaseEvents: string[] = [];
    const prepareUpload = (service as any).prepareUpload.bind(service);
    quarantine.acquireProcessing.mockImplementation(async () => {
      leaseEvents.push('acquired');
      return async () => leaseEvents.push('released');
    });
    jest.spyOn(service as any, 'prepareUpload').mockImplementation(async (...args: any[]) => {
      expect(leaseEvents).toEqual(['acquired']);
      return prepareUpload(...args);
    });

    await expect(service.uploadOwnable(await createUploadBuffer(chain), BASE_SEPOLIA_NETWORK)).rejects.toThrow(
      'Ownable network eip155:8453 does not match route network base-sepolia',
    );

    expect(leaseEvents).toEqual(['acquired', 'released']);
    expect(quarantine.findExactRetry).not.toHaveBeenCalled();
    expect(quarantine.stage).not.toHaveBeenCalled();
    expect(hubState.getOwnableBySubjectId).not.toHaveBeenCalled();
    expect(storage.storePackageArtifacts).not.toHaveBeenCalled();
    expect(storage.storeImmutableEventChain).not.toHaveBeenCalled();
  });

  it('hides stored Ownables from a different Base route', async () => {
    const { service, hubState, storage } = await buildService();
    const chain = await createChain(84532);
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1' });
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));

    await expect(service.downloadOwnable(chain.id, BASE_NETWORK)).rejects.toThrow('Ownable is not available on this network');
    await expect(service.getOwnableVerification(chain.id, BASE_NETWORK)).rejects.toThrow('Ownable is not available on this network');
    await expect(service.getOwnablePublicEvents(chain.id, BASE_NETWORK)).rejects.toThrow('Ownable is not available on this network');
  });

  it('does not disclose a stored Ownable when its signed network cannot be resolved', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();
    delete chain.events[0].parsedData.network_id;
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1' });
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));

    await expect(service.getOwnableVerification(chain.id, BASE_SEPOLIA_NETWORK)).rejects.toThrow(
      'Invalid event chain: invalid network_id in first event',
    );
  });

  it('returns not found for a stored Ownable whose canonical chain is missing', async () => {
    const { service, storage, hubState } = await buildService();
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1' });
    storage.getEventChain.mockRejectedValue(missing);

    await expect(service.getOwnableVerification(`0x${'11'.repeat(32)}`, BASE_SEPOLIA_NETWORK)).rejects.toThrow(
      'Ownable is not available on this network',
    );
  });

  it('surfaces stored-chain backend failures', async () => {
    const { service, storage, hubState } = await buildService();
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1' });
    storage.getEventChain.mockRejectedValue(new Error('archive storage unavailable'));

    await expect(service.getOwnableVerification(`0x${'11'.repeat(32)}`, BASE_SEPOLIA_NETWORK)).rejects.toThrow(
      'archive storage unavailable',
    );
  });

  it('accepts upload with legacy eventChain.json alias', async () => {
    const { service, storage } = await buildService();
    const chain = await createChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
    const buffer = await createUploadBuffer(chain, ['eventChain.json']);

    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));

    const result = await service.uploadOwnable(buffer, BASE_SEPOLIA_NETWORK, undefined, false);

    expect(result.cid).toEqual(expect.any(String));
    expect(storage.storeImmutableEventChain).toHaveBeenCalledWith(chain.id, expect.any(String), expect.any(Buffer));
  });

  it('normalizes matching chain file aliases to the same CID', async () => {
    const { service, storage } = await buildService();
    const chain = await createChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');

    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));

    const canonicalResult = await service.uploadOwnable(
      await createUploadBuffer(chain, ['chain.json']),
      BASE_SEPOLIA_NETWORK,
      undefined,
      false,
    );
    const aliasResult = await service.uploadOwnable(
      await createUploadBuffer(chain, ['eventChain.json']),
      BASE_SEPOLIA_NETWORK,
      undefined,
      false,
    );
    const dualResult = await service.uploadOwnable(
      await createUploadBuffer(chain, ['chain.json', 'eventChain.json']),
      BASE_SEPOLIA_NETWORK,
      undefined,
      false,
    );

    expect(canonicalResult.cid).toEqual(aliasResult.cid);
    expect(aliasResult.cid).toEqual(dualResult.cid);
  });

  it('keeps the static CID and stores a different revision when the signed chain changes', async () => {
    const { service, storage } = await buildService();
    const firstChain = await createChain();
    const secondChain = await createChain();
    secondChain.events[0].signature = `0x${'34'.repeat(65)}`;

    const firstPackageZip = new JSZip();
    firstPackageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    firstPackageZip.file('package.json', JSON.stringify({ name: 'test' }));
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(firstChain.toJSON()), 'utf8'));
    storage.getPackageZip.mockResolvedValue(await firstPackageZip.generateAsync({ type: 'nodebuffer' }));
    const firstResult = await service.uploadOwnable(
      await createUploadBuffer(firstChain, ['chain.json']),
      BASE_SEPOLIA_NETWORK,
      undefined,
      false,
    );

    const secondPackageZip = new JSZip();
    secondPackageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    secondPackageZip.file('package.json', JSON.stringify({ name: 'test' }));
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(secondChain.toJSON()), 'utf8'));
    storage.getPackageZip.mockResolvedValue(await secondPackageZip.generateAsync({ type: 'nodebuffer' }));
    const secondResult = await service.uploadOwnable(
      await createUploadBuffer(secondChain, ['chain.json']),
      BASE_SEPOLIA_NETWORK,
      undefined,
      false,
    );

    expect(firstResult.cid).toEqual(secondResult.cid);
    const [firstWrite, secondWrite] = storage.storeImmutableEventChain.mock.calls;
    expect(firstWrite[1]).not.toBe(secondWrite[1]);
  });

  it('rejects ambiguous archives when chain aliases differ', async () => {
    const { service } = await buildService();
    const chain = await createChain();
    const buffer = await createUploadBuffer(chain, ['chain.json', 'eventChain.json'], {
      'eventChain.json': JSON.stringify({ ...chain.toJSON(), id: `0x${'22'.repeat(32)}` }),
    });

    await expect(service.uploadOwnable(buffer, BASE_SEPOLIA_NETWORK, undefined, false)).rejects.toThrow(
      "Invalid package: 'chain.json' and 'eventChain.json' differ",
    );
  });

  it('rejects wasm-bindgen runtime fixtures as invalid upload input', async () => {
    const { service, storage, hubState, runtimeValidatorSpy } = await buildService();
    const chain = await createChain();
    const buffer = await createUploadBuffer(chain, ['chain.json'], {}, buildWasmBindgenRuntimeWasm());
    runtimeValidatorSpy.mockRestore();

    await expect(service.uploadOwnable(buffer, BASE_SEPOLIA_NETWORK, undefined, false)).rejects.toThrow(
      "Invalid package: unsupported Ownable runtime in 'ownable_bg.wasm'",
    );
    expect(storage.storePackageArtifacts).not.toHaveBeenCalled();
    expect(storage.storeImmutableEventChain).not.toHaveBeenCalled();
    expect(hubState.publishQuarantinedUpload).not.toHaveBeenCalled();
  });

  it('rejects wrong-kind raw-ABI exports before persistence', async () => {
    const { service, storage, hubState, runtimeValidatorSpy } = await buildService();
    const chain = await createChain();
    const buffer = await createUploadBuffer(chain, ['chain.json'], {}, buildWrongKindRuntimeWasm());
    runtimeValidatorSpy.mockRestore();

    await expect(service.uploadOwnable(buffer, BASE_SEPOLIA_NETWORK, undefined, false)).rejects.toThrow(
      "Invalid package: unsupported Ownable runtime in 'ownable_bg.wasm'. Expected raw-ABI exports with no wasm imports; wrong raw-ABI export kinds: memory (expected memory, found global)",
    );
    expect(storage.storePackageArtifacts).not.toHaveBeenCalled();
    expect(storage.storeImmutableEventChain).not.toHaveBeenCalled();
    expect(hubState.publishQuarantinedUpload).not.toHaveBeenCalled();
  });

  it('delegates public replay to core service without persisting replay-derived owner state on download', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
    hubState.getOwnableBySubjectId.mockResolvedValue({
      id: 'id-1',
      packageCid: 'cid-1',
      subjectId: expectedSubjectId(chain.id),
    });

    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([
      {
        id: 'evt-1',
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: ACTIVE_LIVE_IDENTITY.anchorContractAddress,
        blockNumber: '10',
        blockHash: '0x1',
        transactionHash: '0xaaa',
        transactionIndex: 0,
        logIndex: 1,
        eventName: 'PublicEvent',
        cid: 'cid-1',
        ownableId: 'id-1',
        ownerAddress: null,
        subjectId: expectedSubjectId(chain.id),
        sourceAddress: '0x1111111111111111111111111111111111111111',
        eventType: 'ok',
        dataHex: '0x01',
        eventTimestamp: '1',
        payloadJson: {},
        indexedAt: new Date().toISOString(),
      },
    ]);

    const replaySpy = jest.spyOn(CoreOwnableService.prototype, 'attemptReplayIndexedPublicEvents');
    await service.downloadOwnable(chain.id, BASE_SEPOLIA_NETWORK);

    expect(replaySpy).toHaveBeenCalled();
    expect(hubState.getOwnableBySubjectId).toHaveBeenCalledWith(expectedSubjectId(chain.id));
    expect(hubState.listIndexedAnchorEventsByAnchorKeys).toHaveBeenCalledWith(
      chain.anchorMap.map(({ key }) => key.hex),
      ACTIVE_LIVE_IDENTITY,
    );
    expect(hubState.listIndexedPublicEventsBySubjectId).toHaveBeenCalledWith(expectedSubjectId(chain.id), {
      slotName: 'testnet',
      chainId: '84532',
      anchorContractAddress: '0x0000000000000000000000000000000000000001',
    });
    expect(hubState.setOwnerState).not.toHaveBeenCalled();
  });

  it('returns bundle by ownable id without reading legacy persisted owner state', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();
    hubState.getOwnableBySubjectId.mockResolvedValue({
      id: 'id-1',
      packageCid: 'cid-1',
      subjectId: expectedSubjectId(chain.id),
    });

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([]);

    await service.downloadOwnable(chain.id, BASE_SEPOLIA_NETWORK);

    expect(hubState.getOwnerStateByCid).not.toHaveBeenCalled();
  });

  it('keeps ignored public events non-fatal in verification metadata', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();
    hubState.getOwnableBySubjectId.mockResolvedValue({
      id: 'id-1',
      packageCid: 'cid-1',
      subjectId: expectedSubjectId(chain.id),
    });

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([
      {
        id: 'evt-1',
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: ACTIVE_LIVE_IDENTITY.anchorContractAddress,
        blockNumber: '10',
        blockHash: '0x1',
        transactionHash: '0xaaa',
        transactionIndex: 0,
        logIndex: 1,
        eventName: 'PublicEvent',
        cid: 'cid-1',
        ownableId: 'id-1',
        ownerAddress: null,
        subjectId: expectedSubjectId(chain.id),
        sourceAddress: '0x1111111111111111111111111111111111111111',
        eventType: 'reject',
        dataHex: '0x01',
        eventTimestamp: '1',
        payloadJson: {},
        indexedAt: new Date().toISOString(),
      },
    ]);

    await expect(service.downloadOwnable(chain.id, BASE_SEPOLIA_NETWORK)).resolves.toBeDefined();
    const verification = await service.getOwnableVerification(chain.id, BASE_SEPOLIA_NETWORK);
    expect(verification).toEqual(
      expect.objectContaining({
        ownableId: chain.id,
        verified: true,
        ignoredPublicEvents: [
          expect.objectContaining({
            replayKey: '0xaaa:1',
            transactionHash: '0xaaa',
            logIndex: 1,
            reason: 'register_failed',
          }),
        ],
      }),
    );
    expect(verification).not.toHaveProperty('publicEvents');
    expect(verification).not.toHaveProperty('nft');
  });

  it('returns the dedicated public-events snapshot without routing through verification', async () => {
    const { service, hubState } = await buildService();
    const chain = await createChain();
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([
      {
        id: 'evt-1',
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x1',
        blockNumber: '11',
        blockHash: '0x1',
        transactionHash: '0xbbb',
        transactionIndex: 0,
        logIndex: 3,
        eventName: 'PublicEvent',
        cid: 'cid-1',
        ownableId: 'id-1',
        ownerAddress: null,
        subjectId: expectedSubjectId(chain.id),
        sourceAddress: '0x1111111111111111111111111111111111111111',
        eventType: 'transfer',
        dataHex: '0x01',
        eventTimestamp: '42',
        payloadJson: {},
        indexedAt: new Date().toISOString(),
      },
    ]);

    await expect(service.getOwnablePublicEvents(chain.id, BASE_SEPOLIA_NETWORK)).resolves.toEqual({
      ownableId: chain.id,
      publicEvents: [
        {
          source: '0x1111111111111111111111111111111111111111',
          eventType: 'transfer',
          data: '0x01',
          blockNumber: 11,
          transactionHash: '0xbbb',
          transactionIndex: 0,
          logIndex: 3,
          timestamp: 42,
        },
      ],
    });
    expect(hubState.listIndexedPublicEventsBySubjectId).toHaveBeenCalledWith(expectedSubjectId(chain.id), {
      slotName: 'testnet',
      chainId: '84532',
      anchorContractAddress: '0x0000000000000000000000000000000000000001',
    });
  });

  it('replays public-event stream rows from the requested block and then continues live for watched ownables only', async () => {
    const { service, hubState, ownableTransport } = await buildService();
    const ownableA = await createChain();
    const ownableB = new EventChain(`0x${'22'.repeat(32)}`);
    const ownableIgnored = new EventChain(`0x${'33'.repeat(32)}`);
    const liveSubject = new Subject<any>();
    ownableTransport.watchPublicEvents.mockReturnValue(liveSubject);
    hubState.listIndexedPublicEventsBySubjectIdsAfter.mockResolvedValue([
      {
        id: 'evt-a',
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: ACTIVE_LIVE_IDENTITY.anchorContractAddress,
        blockNumber: '11',
        blockHash: '0x1',
        transactionHash: '0xbbb',
        transactionIndex: 0,
        logIndex: 1,
        eventName: 'PublicEvent',
        cid: 'cid-1',
        ownableId: 'id-a',
        ownerAddress: null,
        subjectId: expectedSubjectId(ownableA.id),
        sourceAddress: '0x1111111111111111111111111111111111111111',
        eventType: 'transfer',
        dataHex: '0x01',
        eventTimestamp: '41',
        payloadJson: {},
        indexedAt: new Date().toISOString(),
      },
      {
        id: 'evt-b',
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: ACTIVE_LIVE_IDENTITY.anchorContractAddress,
        blockNumber: '12',
        blockHash: '0x2',
        transactionHash: '0xccc',
        transactionIndex: 1,
        logIndex: 0,
        eventName: 'PublicEvent',
        cid: 'cid-2',
        ownableId: 'id-b',
        ownerAddress: null,
        subjectId: expectedSubjectId(ownableB.id),
        sourceAddress: '0x2222222222222222222222222222222222222222',
        eventType: 'mint',
        dataHex: '0x02',
        eventTimestamp: '42',
        payloadJson: {},
        indexedAt: new Date().toISOString(),
      },
    ]);

    const stream = await service.streamOwnablePublicEvents([ownableA.id, ownableB.id], '11', BASE_SEPOLIA_NETWORK);
    const collectedPromise = firstValueFrom(stream.pipe(take(3), toArray()));
    liveSubject.next({
      subjectId: expectedSubjectId(ownableIgnored.id),
      ...ACTIVE_LIVE_IDENTITY,
      publicEvent: {
        source: '0x3333333333333333333333333333333333333333',
        eventType: 'ignore',
        data: '0x03',
        blockNumber: 13,
        transactionHash: '0xddd',
        transactionIndex: 0,
        logIndex: 0,
        timestamp: 43,
      },
    });
    liveSubject.next({
      subjectId: expectedSubjectId(ownableA.id),
      slotName: 'mainnet',
      chainId: ACTIVE_LIVE_IDENTITY.chainId,
      anchorContractAddress: ACTIVE_LIVE_IDENTITY.anchorContractAddress,
      publicEvent: {
        source: '0x1111111111111111111111111111111111111111',
        eventType: 'ignore-slot',
        data: '0x04',
        blockNumber: 13,
        transactionHash: '0xinactive-slot',
        transactionIndex: 0,
        logIndex: 1,
        timestamp: 44,
      },
    });
    liveSubject.next({
      subjectId: expectedSubjectId(ownableA.id),
      slotName: ACTIVE_LIVE_IDENTITY.slotName,
      chainId: '8453',
      anchorContractAddress: ACTIVE_LIVE_IDENTITY.anchorContractAddress,
      publicEvent: {
        source: '0x1111111111111111111111111111111111111111',
        eventType: 'ignore-chain',
        data: '0x04',
        blockNumber: 13,
        transactionHash: '0xinactive-chain',
        transactionIndex: 0,
        logIndex: 2,
        timestamp: 44,
      },
    });
    liveSubject.next({
      subjectId: expectedSubjectId(ownableA.id),
      slotName: ACTIVE_LIVE_IDENTITY.slotName,
      chainId: ACTIVE_LIVE_IDENTITY.chainId,
      anchorContractAddress: '0x0000000000000000000000000000000000000002',
      publicEvent: {
        source: '0x1111111111111111111111111111111111111111',
        eventType: 'ignore-anchor',
        data: '0x04',
        blockNumber: 13,
        transactionHash: '0xinactive-anchor',
        transactionIndex: 0,
        logIndex: 3,
        timestamp: 44,
      },
    });
    liveSubject.next({
      subjectId: expectedSubjectId(ownableA.id),
      ...ACTIVE_LIVE_IDENTITY,
      anchorContractAddress: ACTIVE_LIVE_IDENTITY.anchorContractAddress.toUpperCase(),
      publicEvent: {
        source: '0x1111111111111111111111111111111111111111',
        eventType: 'transfer',
        data: '0x04',
        blockNumber: 13,
        transactionHash: '0xeee',
        transactionIndex: 0,
        logIndex: 1,
        timestamp: 44,
      },
    });

    await expect(collectedPromise).resolves.toEqual([
      {
        type: 'public-event',
        data: {
          ownableId: ownableA.id,
          publicEvent: {
            source: '0x1111111111111111111111111111111111111111',
            eventType: 'transfer',
            data: '0x01',
            blockNumber: 11,
            transactionHash: '0xbbb',
            transactionIndex: 0,
            logIndex: 1,
            timestamp: 41,
          },
        },
      },
      {
        type: 'public-event',
        data: {
          ownableId: ownableB.id,
          publicEvent: {
            source: '0x2222222222222222222222222222222222222222',
            eventType: 'mint',
            data: '0x02',
            blockNumber: 12,
            transactionHash: '0xccc',
            transactionIndex: 1,
            logIndex: 0,
            timestamp: 42,
          },
        },
      },
      {
        type: 'public-event',
        data: {
          ownableId: ownableA.id,
          publicEvent: {
            source: '0x1111111111111111111111111111111111111111',
            eventType: 'transfer',
            data: '0x04',
            blockNumber: 13,
            transactionHash: '0xeee',
            transactionIndex: 0,
            logIndex: 1,
            timestamp: 44,
          },
        },
      },
    ]);
    expect(hubState.listIndexedPublicEventsBySubjectIdsAfter).toHaveBeenCalledWith(
      [expectedSubjectId(ownableA.id), expectedSubjectId(ownableB.id)],
      11n,
      null,
      {
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x0000000000000000000000000000000000000001',
      },
    );
  });

  it('dedupes a live event buffered before replay completes when replay returns the same event', async () => {
    const { service, hubState, ownableTransport } = await buildService();
    const ownable = await createChain();
    const liveSubject = new Subject<any>();
    ownableTransport.watchPublicEvents.mockReturnValue(liveSubject);

    let resolveReplay!: (rows: any[]) => void;
    hubState.listIndexedPublicEventsBySubjectIdsAfter.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReplay = resolve;
        }),
    );

    const stream = await service.streamOwnablePublicEvents([ownable.id], '11', BASE_SEPOLIA_NETWORK);
    const collectedPromise = firstValueFrom(stream.pipe(take(2), toArray()));

    liveSubject.next({
      subjectId: expectedSubjectId(ownable.id),
      ...ACTIVE_LIVE_IDENTITY,
      publicEvent: {
        source: '0x1111111111111111111111111111111111111111',
        eventType: 'transfer',
        data: '0x01',
        blockNumber: 11,
        transactionHash: '0xbbb',
        transactionIndex: 0,
        logIndex: 1,
        timestamp: 41,
      },
    });

    resolveReplay([
      {
        id: 'evt-a',
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x1',
        blockNumber: '11',
        blockHash: '0x1',
        transactionHash: '0xbbb',
        transactionIndex: 0,
        logIndex: 1,
        eventName: 'PublicEvent',
        cid: 'cid-1',
        ownableId: 'id-a',
        ownerAddress: null,
        subjectId: expectedSubjectId(ownable.id),
        sourceAddress: '0x1111111111111111111111111111111111111111',
        eventType: 'transfer',
        dataHex: '0x01',
        eventTimestamp: '41',
        payloadJson: {},
        indexedAt: new Date().toISOString(),
      },
    ]);

    liveSubject.next({
      subjectId: expectedSubjectId(ownable.id),
      ...ACTIVE_LIVE_IDENTITY,
      publicEvent: {
        source: '0x1111111111111111111111111111111111111111',
        eventType: 'transfer',
        data: '0x02',
        blockNumber: 12,
        transactionHash: '0xccc',
        transactionIndex: 0,
        logIndex: 0,
        timestamp: 42,
      },
    });

    await expect(collectedPromise).resolves.toEqual([
      {
        type: 'public-event',
        data: {
          ownableId: ownable.id,
          publicEvent: {
            source: '0x1111111111111111111111111111111111111111',
            eventType: 'transfer',
            data: '0x01',
            blockNumber: 11,
            transactionHash: '0xbbb',
            transactionIndex: 0,
            logIndex: 1,
            timestamp: 41,
          },
        },
      },
      {
        type: 'public-event',
        data: {
          ownableId: ownable.id,
          publicEvent: {
            source: '0x1111111111111111111111111111111111111111',
            eventType: 'transfer',
            data: '0x02',
            blockNumber: 12,
            transactionHash: '0xccc',
            transactionIndex: 0,
            logIndex: 0,
            timestamp: 42,
          },
        },
      },
    ]);
  });

  it('keeps discovery stream separate and live-only for one owner account', async () => {
    const { service, ownableTransport } = await buildService();
    const liveSubject = new Subject<any>();
    ownableTransport.watchAvailableOwnables.mockReturnValue(liveSubject);

    const stream = service.streamAvailableOwnables(REPLAY_OWNER_WALLET.address, BASE_SEPOLIA_NETWORK);
    const collectedPromise = firstValueFrom(stream.pipe(take(1), toArray()));
    liveSubject.next({
      owner: 'eip155:84532:0xsomeoneelse',
      entry: {
        id: '0xignore',
        title: 'Ignore',
        availableAt: '2026-06-07T10:00:00.000Z',
        package: { cid: 'cid-ignore', thumbnailUrl: null },
      },
    });
    liveSubject.next({
      owner: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
      entry: {
        id: '0x11',
        title: 'Potion',
        availableAt: '2026-06-07T10:02:00.000Z',
        package: { cid: 'cid-1', thumbnailUrl: 'https://example.com/potion.png' },
      },
    });

    await expect(collectedPromise).resolves.toEqual([
      {
        type: 'available-ownable',
        data: {
          owner: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
          entry: {
            id: '0x11',
            title: 'Potion',
            availableAt: '2026-06-07T10:02:00.000Z',
            package: {
              cid: 'cid-1',
              thumbnailUrl: 'https://example.com/potion.png',
            },
          },
        },
      },
    ]);
  });

  it('marks verification false when indexed anchor evidence is missing for the requested key', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain(undefined, [{ key: { hex: '0xanchor' }, value: { hex: '0xbbb' } }]);
    hubState.getOwnableBySubjectId.mockResolvedValue({
      id: 'id-1',
      packageCid: 'cid-1',
      subjectId: expectedSubjectId(chain.id),
    });
    hubState.listIndexedAnchorEventsByAnchorKeys.mockResolvedValue([
      {
        transactionHash: '0xaaa',
        blockNumber: '10',
        transactionIndex: 0,
        logIndex: 0,
        ownerAddress: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase(),
        payloadJson: { key: '0xother', value: '0xbbb' },
      },
    ]);

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([]);

    await expect(service.getOwnableVerification(chain.id, BASE_SEPOLIA_NETWORK)).resolves.toEqual(
      expect.objectContaining({
        verified: false,
        anchorVerification: expect.objectContaining({
          verified: false,
          anchors: { '0xanchor': undefined },
          details: {
            '0xanchor': expect.objectContaining({
              key: '0xanchor',
              expectedValue: '0xbbb',
              value: '0xbbb',
              verified: false,
            }),
          },
        }),
      }),
    );
  });

  it('marks verification false when indexed anchor evidence value mismatches the requested key', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain(undefined, [{ key: { hex: '0xanchor' }, value: { hex: '0xbbb' } }]);
    hubState.getOwnableBySubjectId.mockResolvedValue({
      id: 'id-1',
      packageCid: 'cid-1',
      subjectId: expectedSubjectId(chain.id),
    });
    hubState.listIndexedAnchorEventsByAnchorKeys.mockResolvedValue([
      {
        transactionHash: '0xaaa',
        blockNumber: '10',
        transactionIndex: 0,
        logIndex: 0,
        ownerAddress: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase(),
        payloadJson: { key: '0xanchor', value: '0xccc' },
      },
    ]);

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([]);

    await expect(service.getOwnableVerification(chain.id, BASE_SEPOLIA_NETWORK)).resolves.toEqual(
      expect.objectContaining({
        verified: false,
        anchorVerification: expect.objectContaining({
          verified: false,
          anchors: { '0xanchor': '0xaaa' },
          map: { '0xanchor': '0xccc' },
          details: {
            '0xanchor': expect.objectContaining({
              key: '0xanchor',
              expectedValue: '0xbbb',
              value: '0xccc',
              transactionHash: '0xaaa',
              verified: false,
            }),
          },
        }),
      }),
    );
  });

  it('marks verification true only when matching indexed anchor evidence exists for the requested key', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain(undefined, [{ key: { hex: '0xanchor' }, value: { hex: '0xbbb' } }]);
    hubState.getOwnableBySubjectId.mockResolvedValue({
      id: 'id-1',
      packageCid: 'cid-1',
      subjectId: expectedSubjectId(chain.id),
    });
    hubState.listIndexedAnchorEventsByAnchorKeys.mockResolvedValue([
      {
        transactionHash: '0xolder',
        blockNumber: '9',
        transactionIndex: 0,
        logIndex: 0,
        ownerAddress: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase(),
        payloadJson: { key: '0xanchor', value: '0xaaa' },
      },
      {
        transactionHash: '0xaaa',
        blockNumber: '10',
        transactionIndex: 0,
        logIndex: 1,
        ownerAddress: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase(),
        payloadJson: { key: '0xanchor', value: '0xbbb' },
      },
      {
        transactionHash: '0xother',
        blockNumber: '11',
        transactionIndex: 0,
        logIndex: 2,
        ownerAddress: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase(),
        payloadJson: { key: '0xother', value: '0xddd' },
      },
    ]);

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([]);

    await expect(service.getOwnableVerification(chain.id, BASE_SEPOLIA_NETWORK)).resolves.toEqual(
      expect.objectContaining({
        verified: true,
        anchorVerification: expect.objectContaining({
          verified: true,
          anchors: { '0xanchor': '0xaaa' },
          map: { '0xanchor': '0xbbb' },
          details: {
            '0xanchor': expect.objectContaining({
              key: '0xanchor',
              expectedValue: '0xbbb',
              value: '0xbbb',
              transactionHash: '0xaaa',
              verified: true,
            }),
          },
        }),
      }),
    );
  });

  it('preserves archive shape without synthesizing authority_claim_msg.json', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();
    hubState.getOwnableBySubjectId.mockResolvedValue({
      id: 'id-1',
      packageCid: 'cid-1',
      subjectId: expectedSubjectId(chain.id),
    });

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    packageZip.file('package.json', JSON.stringify({ name: 'pkg' }));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([]);

    const file = await service.downloadOwnable(chain.id, BASE_SEPOLIA_NETWORK);
    const buffer = await toBuffer(file.getStream() as Readable);
    const outputZip = await new JSZip().loadAsync(buffer);

    expect(outputZip.file('chain.json')).toBeTruthy();
    expect(outputZip.file('eventChain.json')).toBeNull();
    expect(outputZip.file('authority_claim_msg.json')).toBeNull();
  });

  it('returns available ownables with stable keys and import metadata', async () => {
    const { service, hubState, storage } = await buildService();
    const chain = await createChain();
    hubState.listAvailableOwnablesByOwnerAccount.mockResolvedValue([
      {
        ownableId: '00000000-0000-0000-0000-000000000101',
        packageCid: 'cid-1',
        subjectId: expectedSubjectId(chain.id),
        ownerAccount: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
        ownerStateVersion: 4,
        availableAt: '2026-06-07T10:02:00.000Z',
        issuerAddress: '0xissuer',
      },
    ]);
    const packageZip = new JSZip();
    packageZip.file(
      'package.json',
      JSON.stringify({
        name: 'ownable-potion',
        description: 'Recovered from the stored package.',
        thumbnailUrl: 'https://example.com/potion.png',
      }),
    );
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));

    await expect(service.getAvailableOwnables(REPLAY_OWNER_WALLET.address, BASE_SEPOLIA_NETWORK)).resolves.toEqual({
      owner: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
      entries: [
        {
          id: chain.id,
          title: 'Potion',
          description: 'Recovered from the stored package.',
          issuer: '0xissuer',
          availableAt: '2026-06-07T10:02:00.000Z',
          package: {
            cid: 'cid-1',
            thumbnailUrl: 'https://example.com/potion.png',
          },
        },
      ],
    });
    const result = await service.getAvailableOwnables(REPLAY_OWNER_WALLET.address, BASE_SEPOLIA_NETWORK);
    expect(result).not.toHaveProperty('ownerAccount');
    expect(result.entries[0]).not.toHaveProperty('import');
    expect(result.entries[0]).not.toHaveProperty('availabilityKey');
    expect(result.entries[0]).not.toHaveProperty('subjectId');
    expect(result.entries[0]).not.toHaveProperty('ownerStateVersion');
    expect(hubState.listAvailableOwnablesByOwnerAccount).toHaveBeenCalledWith(
      `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
    );
  });

  it('includes the discovery transition in the atomic publication request', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
    const buffer = await createUploadBuffer(chain);
    const packageZip = new JSZip();
    packageZip.file(
      'package.json',
      JSON.stringify({
        name: 'ownable-potion',
        description: 'Recovered from the stored package.',
        thumbnailUrl: 'https://example.com/potion.png',
      }),
    );
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listAvailableOwnablesByOwnerAccount.mockResolvedValue([
      {
        ownableId: 'id-1',
        packageCid: 'cid-uploaded',
        subjectId: expectedSubjectId(chain.id),
        ownerAccount: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
        ownerStateVersion: 4,
        availableAt: '2026-06-07T10:02:00.000Z',
        issuerAddress: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase(),
      },
    ]);

    await service.uploadOwnable(buffer, BASE_SEPOLIA_NETWORK, undefined, false);

    expect(hubState.publishQuarantinedUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: {
          owner: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
          entry: {
            id: chain.id,
            title: 'Potion',
            description: 'Recovered from the stored package.',
            issuer: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase(),
            availableAt: expect.any(String),
            package: {
              cid: expect.any(String),
              thumbnailUrl: 'https://example.com/potion.png',
            },
          },
        },
      }),
    );
  });

  it('falls back to cid metadata when stored package metadata is unavailable', async () => {
    const { service, hubState, storage } = await buildService();
    const chain = await createChain();
    hubState.listAvailableOwnablesByOwnerAccount.mockResolvedValue([
      {
        ownableId: '00000000-0000-0000-0000-000000000102',
        packageCid: 'cid-2',
        subjectId: null,
        ownerAccount: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
        ownerStateVersion: 1,
        availableAt: '2026-06-08T12:00:00.000Z',
        issuerAddress: '0xissuer',
      },
    ]);
    storage.getPackageZip.mockRejectedValue(new Error('missing package zip'));
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));

    await expect(service.getAvailableOwnables(REPLAY_OWNER_WALLET.address, BASE_SEPOLIA_NETWORK)).resolves.toEqual({
      owner: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
      entries: [
        {
          id: chain.id,
          title: 'cid-2',
          issuer: '0xissuer',
          availableAt: '2026-06-08T12:00:00.000Z',
          package: {
            cid: 'cid-2',
            thumbnailUrl: null,
          },
        },
      ],
    });
  });

  it('rejects recipient discovery when owner input is missing or malformed', async () => {
    const { service } = await buildService();

    await expect(service.getAvailableOwnables('', BASE_SEPOLIA_NETWORK)).rejects.toThrow('owner must be a valid EVM address');
    await expect(service.getAvailableOwnables('not-an-address', BASE_SEPOLIA_NETWORK)).rejects.toThrow('owner must be a valid EVM address');
  });
});
