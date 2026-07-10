import JSZip from 'jszip';
import { Readable } from 'stream';
import { ethers } from 'ethers';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { Event, EventChain } from '../test-mocks/eqty-core.js';
import { OwnableService } from './ownable.service.js';
import { OwnableService as CoreOwnableService } from '@ownables/core';
import { firstValueFrom, Subject } from 'rxjs';
import { take, toArray } from 'rxjs/operators';

const PRIVATE_STATE_OWNER_WALLET = ethers.Wallet.createRandom();
const REPLAY_OWNER_WALLET = ethers.Wallet.createRandom();
const REPLAY_NFT_INFO = { network: 'eip155:base', address: '0xabc', id: '1' };
const DEFAULT_ANCHORS = [{ key: { hex: '0xanchor' }, value: { hex: '0xbbb' } }];
let mockReplayInfo: Record<string, unknown>;

jest.mock('eqty-core', () => require('../test-mocks/eqty-core.ts'));
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
      verified: anchors.length > 0 && Object.values(details).every((detail) => detail.verified && detail.transactionHash),
      anchors: Object.fromEntries(
        anchors.map(({ key }) => [key.hex, details[key.hex]?.transactionHash as string | undefined]),
      ),
      map: Object.fromEntries(anchors.map(({ key }) => [key.hex, details[key.hex]?.value ?? ''])),
      details,
    };
  };

  class MockCoreEventChainService {
    constructor(private readonly _stateStore: any, private readonly anchorProvider: any) {}
    async verify(chain: any) {
      return this.anchorProvider.verifyAnchors(...(chain.anchorMap ?? []));
    }
  }

  class MockCoreOwnableService {
    private readonly rpcStore = new Map<string, any>();
    constructor(..._args: any[]) {}
    async initWorker(id: string, _cid: string) {
      this.rpcStore.set(id, {
        query: async () => mockReplayInfo,
      });
    }
    async apply(_chain: any, _state: any[]) {
      return [];
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
        appliedPublicEvents: indexedPublicEvents.map((event) => ({ replayKey: `${event.transactionHash}:${event.logIndex}`, event })),
        duplicatePublicEvents: [],
        ignoredPublicEvents: [],
      };
    }
    rpc(id: string) {
      return this.rpcStore.get(id);
    }
    clearRpc(_id: string) {}
  }

  return {
    calculateOwnablePackageCid: (entries: Array<{ path: string; content?: Uint8Array | Buffer }>) =>
      `cid-${entries
        .map((entry) => {
          const content = Buffer.from(entry.content ?? []).toString('hex');
          return `${entry.path}:${content}`;
        })
        .sort()
        .join('-')}`,
    evaluateReplayFreshness: (events: any[], appliedReplayKeys: string[]) => {
      const keys = events.map((event) => `${event.transactionHash}:${event.logIndex}`);
      const missingReplayKeys = keys.filter((key) => !appliedReplayKeys.includes(key));
      return { stale: missingReplayKeys.length > 0, missingReplayKeys };
    },
    publicEventReplayKey: (event: any) => `${event.transactionHash}:${event.logIndex}`,
    validateAnchorsAgainstIndexedRecords,
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
  };
});

describe('OwnableService', () => {
  beforeEach(() => {
    mockReplayInfo = {
      owner: REPLAY_OWNER_WALLET.address.toLowerCase(),
      nft: REPLAY_NFT_INFO,
    };
  });

  const buildConfig = () => ({
    getRuntimeNetworkProfile: () => 'testnet',
    getAuthoritySignerMnemonic: () => PRIVATE_STATE_OWNER_WALLET.mnemonic?.phrase || '',
    getAppConfig: () => ({ publicBaseUrl: 'http://127.0.0.1:8000' }),
    isLocalDevRecipientDiscoveryEnabled: () => true,
  });

  const buildService = async () => {
    const nft = {
      getOwnerOfNFT: jest.fn().mockResolvedValue(PRIVATE_STATE_OWNER_WALLET.address),
      isNFTlocked: jest.fn().mockResolvedValue(true),
      getUnlockProof: jest.fn().mockResolvedValue('unlock-proof'),
      isUnlockProofValid: jest.fn().mockResolvedValue(true),
      getNFTcount: jest.fn().mockResolvedValue('42'),
      GetServerETHBalance: jest.fn().mockResolvedValue('1.00'),
    };
    const storage = {
      storePackageArtifacts: jest.fn().mockResolvedValue(undefined),
      storeEventChain: jest.fn().mockResolvedValue(undefined),
      hasEventChain: jest.fn().mockResolvedValue(true),
      hasPackage: jest.fn().mockResolvedValue(true),
      getEventChain: jest.fn(),
      getPackageZip: jest.fn(),
    };
    const hubState = {
      upsertOwnableRecord: jest.fn().mockResolvedValue({ id: 'id-1' }),
      setOwnerState: jest.fn().mockResolvedValue(undefined),
      getOwnerStateByCid: jest.fn().mockResolvedValue({ owner: REPLAY_OWNER_WALLET.address.toLowerCase(), version: 1, latestAppliedPublicEventId: null }),
      getOwnableByCid: jest.fn().mockResolvedValue({ id: 'id-1', packageCid: 'cid-1' }),
      getOwnableByNft: jest.fn(),
      getOwnableBySubjectId: jest.fn().mockResolvedValue(null),
      listAvailableOwnablesByOwnerAccount: jest.fn().mockResolvedValue([]),
      listOwnableCidsByPrevOwner: jest.fn().mockResolvedValue(['cid-a']),
      listWalletEventsByCid: jest.fn().mockResolvedValue([]),
      listIndexedAnchorEventsByPackageCid: jest.fn().mockResolvedValue([
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
    };
    const ownableTransport = {
      publishPublicEvent: jest.fn(),
      watchPublicEvents: jest.fn(),
      publishAvailableOwnable: jest.fn(),
      watchAvailableOwnables: jest.fn(),
    };
    const service = new OwnableService(buildConfig() as any, nft as any, storage as any, hubState as any, ownableTransport as any);
    const runtimeValidatorSpy = jest
      .spyOn(service as any, 'assertSupportedOwnableRuntime')
      .mockImplementation(() => undefined);

    await service.onModuleInit();
    return { service, nft, storage, hubState, ownableTransport, runtimeValidatorSpy };
  };

  const createChain = async (
    nft = { network: 'eip155:base', address: '0xabc', id: '1' },
    anchors: Array<{ key: { hex: string }; value: { hex: string } }> = DEFAULT_ANCHORS,
  ) => {
    const chain = new EventChain(`0x${'11'.repeat(32)}`);
    const signer = {
      getAddress: async () => PRIVATE_STATE_OWNER_WALLET.address,
      signTypedData: async () => `0x${'00'.repeat(65)}`,
    };
    const event = new Event({ '@context': 'instantiate_msg.json', nft, anchors });
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

  const storedOwnableId = async () => (await createChain()).id;
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

    const globalSection = section(6, [
      ...encodeU32(1),
      0x7f,
      0x00,
      0x41,
      0x00,
      0x0b,
    ]);

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

  it('accepts upload without SIWE signer ownership gating', async () => {
    const { service, storage, hubState, nft } = await buildService();
    const chain = await createChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
    const buffer = await createUploadBuffer(chain);
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    packageZip.file('package.json', JSON.stringify({ name: 'test' }));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));

    const result = await service.uploadOwnable(buffer, undefined, false);

    expect(result.cid).toEqual(expect.any(String));
    expect(result.ownerAccount).toEqual(`eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`);
    expect(storage.storePackageArtifacts).toHaveBeenCalledTimes(1);
    expect(storage.storeEventChain).toHaveBeenCalledTimes(1);
    expect(hubState.upsertOwnableRecord).toHaveBeenCalledTimes(1);
    expect(nft.getOwnerOfNFT).not.toHaveBeenCalled();
    expect(hubState.setOwnerState).toHaveBeenCalledWith(
      'id-1',
      REPLAY_OWNER_WALLET.address.toLowerCase(),
      `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
      null,
    );
  });

  it('accepts localhost-issued uploads when nft metadata is only available from replayed ownable info', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createSdkIssuedChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
    const buffer = await createUploadBuffer(chain);
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    packageZip.file('package.json', JSON.stringify({ name: 'test' }));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));

    const result = await service.uploadOwnable(buffer, undefined, false);

    expect(result.owner).toEqual(REPLAY_OWNER_WALLET.address.toLowerCase());
    expect(result.ownerAccount).toEqual(`eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`);
    expect(result.nftNetwork).toEqual(REPLAY_NFT_INFO.network);
    expect(result.smartContractAddress).toEqual(REPLAY_NFT_INFO.address);
    expect(result.NftId).toEqual(REPLAY_NFT_INFO.id);
    expect(hubState.upsertOwnableRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: expectedSubjectId(chain.id),
        nftNetwork: REPLAY_NFT_INFO.network,
        nftContractAddress: REPLAY_NFT_INFO.address,
        nftTokenId: REPLAY_NFT_INFO.id,
      }),
    );
    expect(hubState.setOwnerState).toHaveBeenCalledWith(
      'id-1',
      REPLAY_OWNER_WALLET.address.toLowerCase(),
      `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
      null,
    );
  });

  it('accepts localhost-issued uploads when nft metadata is only available from a stored subject record', async () => {
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
    hubState.getOwnableBySubjectId.mockResolvedValue({
      id: 'own-existing',
      packageCid: 'cid-existing',
      prevOwnerAddress: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase(),
      subjectId: expectedSubjectId(chain.id),
      nftNetwork: REPLAY_NFT_INFO.network,
      nftContractAddress: REPLAY_NFT_INFO.address,
      nftTokenId: REPLAY_NFT_INFO.id,
    });

    const result = await service.uploadOwnable(buffer, undefined, false);

    expect(result.owner).toEqual(REPLAY_OWNER_WALLET.address.toLowerCase());
    expect(result.ownerAccount).toEqual(`eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`);
    expect(result.nftNetwork).toEqual(REPLAY_NFT_INFO.network);
    expect(result.smartContractAddress).toEqual(REPLAY_NFT_INFO.address);
    expect(result.NftId).toEqual(REPLAY_NFT_INFO.id);
    expect(hubState.getOwnableBySubjectId).toHaveBeenCalledWith(expectedSubjectId(chain.id));
    expect(hubState.upsertOwnableRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: expectedSubjectId(chain.id),
        nftNetwork: REPLAY_NFT_INFO.network,
        nftContractAddress: REPLAY_NFT_INFO.address,
        nftTokenId: REPLAY_NFT_INFO.id,
      }),
    );
    expect(hubState.setOwnerState).toHaveBeenCalledWith(
      'id-1',
      REPLAY_OWNER_WALLET.address.toLowerCase(),
      `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
      null,
    );
  });

  it('accepts first localhost transfer uploads without any nft metadata source and derives ownerAccount from network_id', async () => {
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

    const result = await service.uploadOwnable(buffer, undefined, false);

    expect(result.owner).toEqual(REPLAY_OWNER_WALLET.address.toLowerCase());
    expect(result.ownerAccount).toEqual(`eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`);
    expect(result).not.toHaveProperty('nftNetwork');
    expect(result).not.toHaveProperty('smartContractAddress');
    expect(result).not.toHaveProperty('NftId');
    expect(hubState.upsertOwnableRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: expectedSubjectId(chain.id),
        nftNetwork: undefined,
        nftContractAddress: undefined,
        nftTokenId: undefined,
      }),
    );
    expect(hubState.setOwnerState).toHaveBeenCalledWith(
      'id-1',
      REPLAY_OWNER_WALLET.address.toLowerCase(),
      `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
      null,
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

    const result = await service.uploadOwnable(buffer, undefined, false);

    expect(result.cid).toEqual(expect.any(String));
    expect(storage.storeEventChain).toHaveBeenCalledWith('id-1', expect.any(Buffer));
  });

  it('normalizes matching chain file aliases to the same CID', async () => {
    const { service, storage } = await buildService();
    const chain = await createChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');

    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));

    const canonicalResult = await service.uploadOwnable(await createUploadBuffer(chain, ['chain.json']), undefined, false);
    const aliasResult = await service.uploadOwnable(await createUploadBuffer(chain, ['eventChain.json']), undefined, false);
    const dualResult = await service.uploadOwnable(await createUploadBuffer(chain, ['chain.json', 'eventChain.json']), undefined, false);

    expect(canonicalResult.cid).toEqual(aliasResult.cid);
    expect(aliasResult.cid).toEqual(dualResult.cid);
  });

  it('produces distinct CIDs for repeated transfers when the event chain changes', async () => {
    const { service, storage } = await buildService();
    const firstChain = await createChain();
    const secondChain = await createChain();
    secondChain.events[0].signature = `0x${'34'.repeat(65)}`;

    const firstPackageZip = new JSZip();
    firstPackageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    firstPackageZip.file('package.json', JSON.stringify({ name: 'test' }));
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(firstChain.toJSON()), 'utf8'));
    storage.getPackageZip.mockResolvedValue(await firstPackageZip.generateAsync({ type: 'nodebuffer' }));
    const firstResult = await service.uploadOwnable(await createUploadBuffer(firstChain, ['chain.json']), undefined, false);

    const secondPackageZip = new JSZip();
    secondPackageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    secondPackageZip.file('package.json', JSON.stringify({ name: 'test' }));
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(secondChain.toJSON()), 'utf8'));
    storage.getPackageZip.mockResolvedValue(await secondPackageZip.generateAsync({ type: 'nodebuffer' }));
    const secondResult = await service.uploadOwnable(await createUploadBuffer(secondChain, ['chain.json']), undefined, false);

    expect(firstResult.cid).not.toEqual(secondResult.cid);
  });

  it('rejects ambiguous archives when chain aliases differ', async () => {
    const { service } = await buildService();
    const chain = await createChain();
    const buffer = await createUploadBuffer(chain, ['chain.json', 'eventChain.json'], {
      'eventChain.json': JSON.stringify({ ...chain.toJSON(), id: `0x${'22'.repeat(32)}` }),
    });

    await expect(service.uploadOwnable(buffer, undefined, false)).rejects.toThrow("Invalid package: 'chain.json' and 'eventChain.json' differ");
  });

  it('rejects wasm-bindgen runtime fixtures as invalid upload input', async () => {
    const { service, storage, hubState, runtimeValidatorSpy } = await buildService();
    const chain = await createChain();
    const wasmBindgenRuntime = await readFile(join(__dirname, '..', 'cosmwasm', '_test', 'ownable_bg.wasm'));
    const buffer = await createUploadBuffer(chain, ['chain.json'], {}, wasmBindgenRuntime);
    runtimeValidatorSpy.mockRestore();

    await expect(service.uploadOwnable(buffer, undefined, false)).rejects.toThrow(
      "Invalid package: unsupported Ownable runtime in 'ownable_bg.wasm'",
    );
    expect(storage.storePackageArtifacts).not.toHaveBeenCalled();
    expect(storage.storeEventChain).not.toHaveBeenCalled();
    expect(hubState.upsertOwnableRecord).not.toHaveBeenCalled();
  });

  it('rejects wrong-kind raw-ABI exports before persistence', async () => {
    const { service, storage, hubState, runtimeValidatorSpy } = await buildService();
    const chain = await createChain();
    const buffer = await createUploadBuffer(chain, ['chain.json'], {}, buildWrongKindRuntimeWasm());
    runtimeValidatorSpy.mockRestore();

    await expect(service.uploadOwnable(buffer, undefined, false)).rejects.toThrow(
      "Invalid package: unsupported Ownable runtime in 'ownable_bg.wasm'. Expected raw-ABI exports with no wasm imports; wrong raw-ABI export kinds: memory (expected memory, found global)",
    );
    expect(storage.storePackageArtifacts).not.toHaveBeenCalled();
    expect(storage.storeEventChain).not.toHaveBeenCalled();
    expect(hubState.upsertOwnableRecord).not.toHaveBeenCalled();
  });

  it('delegates public replay to core service without persisting replay-derived owner state on download', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1', subjectId: expectedSubjectId(chain.id) });

    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([
      {
        id: 'evt-1',
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x1',
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
    await service.downloadOwnable(chain.id);

    expect(replaySpy).toHaveBeenCalled();
    expect(hubState.getOwnableBySubjectId).toHaveBeenCalledWith(expectedSubjectId(chain.id));
    expect(hubState.listIndexedPublicEventsBySubjectId).toHaveBeenCalledWith(expectedSubjectId(chain.id));
    expect(hubState.setOwnerState).not.toHaveBeenCalled();
  });

  it('returns bundle by ownable id without reading legacy persisted owner state', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1', subjectId: expectedSubjectId(chain.id) });

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([]);

    await service.downloadOwnable(chain.id);

    expect(hubState.getOwnerStateByCid).not.toHaveBeenCalled();
  });

  it('keeps ignored public events non-fatal in verification metadata', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1', subjectId: expectedSubjectId(chain.id) });

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([
      {
        id: 'evt-1',
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x1',
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

    await expect(service.downloadOwnable(chain.id)).resolves.toBeDefined();
    await expect(service.getOwnableVerification(chain.id)).resolves.toEqual(
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

    await expect(service.getOwnablePublicEvents(chain.id)).resolves.toEqual({
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
    expect(hubState.listIndexedPublicEventsBySubjectId).toHaveBeenCalledWith(expectedSubjectId(chain.id));
  });

  it('replays public-event stream rows from the requested block and then continues live for watched ownables only', async () => {
    const { service, hubState, ownableTransport } = await buildService();
    const ownableA = await createChain();
    const ownableB = new EventChain(`0x${'22'.repeat(32)}`);
    const ownableIgnored = new EventChain(`0x${'33'.repeat(32)}`);
    const liveSubject = new Subject<any>();
    ownableTransport.watchPublicEvents.mockReturnValue(liveSubject);
    hubState.listIndexedPublicEventsBySubjectId.mockImplementation(async (subjectId: string) => {
      if (subjectId === expectedSubjectId(ownableA.id)) {
        return [
          {
            id: 'evt-old',
            slotName: 'testnet',
            chainId: '84532',
            anchorContractAddress: '0x1',
            blockNumber: '10',
            blockHash: '0x1',
            transactionHash: '0xaaa',
            transactionIndex: 0,
            logIndex: 0,
            eventName: 'PublicEvent',
            cid: 'cid-1',
            ownableId: 'id-a',
            ownerAddress: null,
            subjectId,
            sourceAddress: '0x1111111111111111111111111111111111111111',
            eventType: 'skip',
            dataHex: '0x00',
            eventTimestamp: '40',
            payloadJson: {},
            indexedAt: new Date().toISOString(),
          },
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
            subjectId,
            sourceAddress: '0x1111111111111111111111111111111111111111',
            eventType: 'transfer',
            dataHex: '0x01',
            eventTimestamp: '41',
            payloadJson: {},
            indexedAt: new Date().toISOString(),
          },
        ];
      }
      if (subjectId === expectedSubjectId(ownableB.id)) {
        return [
          {
            id: 'evt-b',
            slotName: 'testnet',
            chainId: '84532',
            anchorContractAddress: '0x1',
            blockNumber: '12',
            blockHash: '0x2',
            transactionHash: '0xccc',
            transactionIndex: 1,
            logIndex: 0,
            eventName: 'PublicEvent',
            cid: 'cid-2',
            ownableId: 'id-b',
            ownerAddress: null,
            subjectId,
            sourceAddress: '0x2222222222222222222222222222222222222222',
            eventType: 'mint',
            dataHex: '0x02',
            eventTimestamp: '42',
            payloadJson: {},
            indexedAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    const stream = await service.streamOwnablePublicEvents([ownableA.id, ownableB.id], '11');
    const collectedPromise = firstValueFrom(stream.pipe(take(3), toArray()));
    liveSubject.next({
      subjectId: expectedSubjectId(ownableIgnored.id),
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
  });

  it('keeps discovery stream separate and live-only for one owner account', async () => {
    const { service, ownableTransport } = await buildService();
    const liveSubject = new Subject<any>();
    ownableTransport.watchAvailableOwnables.mockReturnValue(liveSubject);

    const stream = service.streamAvailableOwnables(`eip155:84532:${REPLAY_OWNER_WALLET.address}`);
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
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1', subjectId: expectedSubjectId(chain.id) });
    hubState.listIndexedAnchorEventsByPackageCid.mockResolvedValue([
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

    await expect(service.getOwnableVerification(chain.id)).resolves.toEqual(
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
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1', subjectId: expectedSubjectId(chain.id) });
    hubState.listIndexedAnchorEventsByPackageCid.mockResolvedValue([
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

    await expect(service.getOwnableVerification(chain.id)).resolves.toEqual(
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
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1', subjectId: expectedSubjectId(chain.id) });
    hubState.listIndexedAnchorEventsByPackageCid.mockResolvedValue([
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

    await expect(service.getOwnableVerification(chain.id)).resolves.toEqual(
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
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1', subjectId: expectedSubjectId(chain.id) });

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    packageZip.file('package.json', JSON.stringify({ name: 'pkg' }));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listIndexedPublicEventsBySubjectId.mockResolvedValue([]);

    const file = await service.downloadOwnable(chain.id);
    const buffer = await toBuffer(file.getStream() as Readable);
    const outputZip = await new JSZip().loadAsync(buffer);

    expect(outputZip.file('chain.json')).toBeTruthy();
    expect(outputZip.file('eventChain.json')).toBeNull();
    expect(outputZip.file('authority_claim_msg.json')).toBeNull();
  });

  it('requires signer for unlock proof', async () => {
    const { service } = await buildService();
    const chainId = await storedOwnableId();
    await expect(service.getUnlockProof(chainId)).rejects.toThrow('Missing SIWE signer');
  });

  it('rejects unlock proof when nft metadata is unavailable', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createSdkIssuedChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    mockReplayInfo = { owner: REPLAY_OWNER_WALLET.address.toLowerCase() };
    hubState.getOwnableBySubjectId.mockResolvedValue({ id: 'id-1', packageCid: 'cid-1', subjectId: expectedSubjectId(chain.id) });

    await expect(service.getUnlockProof(chain.id, { address: PRIVATE_STATE_OWNER_WALLET.address })).rejects.toThrow(
      'NFT metadata is unavailable for this ownable',
    );
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
        nftNetwork: 'eip155:base',
        nftContractAddress: '0xnft',
        nftTokenId: '1',
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

    await expect(
      service.getAvailableOwnables(`eip155:84532:${REPLAY_OWNER_WALLET.address}`),
    ).resolves.toEqual({
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
    const result = await service.getAvailableOwnables(`eip155:84532:${REPLAY_OWNER_WALLET.address}`);
    expect(result).not.toHaveProperty('ownerAccount');
    expect(result.entries[0]).not.toHaveProperty('import');
    expect(result.entries[0]).not.toHaveProperty('availabilityKey');
    expect(result.entries[0]).not.toHaveProperty('subjectId');
    expect(result.entries[0]).not.toHaveProperty('ownerStateVersion');
    expect(hubState.listAvailableOwnablesByOwnerAccount).toHaveBeenCalledWith(
      `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
    );
  });

  it('publishes a discovery update after storing a newly available ownable', async () => {
    const { service, storage, hubState, ownableTransport } = await buildService();
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
        nftNetwork: 'eip155:base',
        nftContractAddress: '0xnft',
        nftTokenId: '1',
      },
    ]);

    await service.uploadOwnable(buffer, undefined, false);

    expect(ownableTransport.publishAvailableOwnable).toHaveBeenCalledWith({
      owner: `eip155:84532:${REPLAY_OWNER_WALLET.address.toLowerCase()}`,
      entry: {
        id: chain.id,
        title: 'Potion',
        description: 'Recovered from the stored package.',
        issuer: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase(),
        availableAt: '2026-06-07T10:02:00.000Z',
        package: {
          cid: expect.any(String),
          thumbnailUrl: 'https://example.com/potion.png',
        },
      },
    });
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
        nftNetwork: null,
        nftContractAddress: null,
        nftTokenId: null,
      },
    ]);
    storage.getPackageZip.mockRejectedValue(new Error('missing package zip'));
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));

    await expect(
      service.getAvailableOwnables(`eip155:84532:${REPLAY_OWNER_WALLET.address}`),
    ).resolves.toEqual({
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

    await expect(service.getAvailableOwnables('')).rejects.toThrow('owner is required');
    await expect(service.getAvailableOwnables('not-caip10')).rejects.toThrow('owner must be a valid CAIP-10 account');
  });
});
