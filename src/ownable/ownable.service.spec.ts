import JSZip from 'jszip';
import { Readable } from 'stream';
import { ethers } from 'ethers';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { Event, EventChain } from '../test-mocks/eqty-core.js';
import { OwnableService } from './ownable.service.js';
import { OwnableService as CoreOwnableService } from '@ownables/core';

const PRIVATE_STATE_OWNER_WALLET = ethers.Wallet.createRandom();
const REPLAY_OWNER_WALLET = ethers.Wallet.createRandom();

jest.mock('eqty-core', () => require('../test-mocks/eqty-core.ts'));
jest.mock('@ownables/core', () => {
  class MockCoreEventChainService {
    constructor(..._args: any[]) {}
  }

  class MockCoreOwnableService {
    private readonly rpcStore = new Map<string, any>();
    constructor(..._args: any[]) {}
    async initWorker(id: string, _cid: string) {
      this.rpcStore.set(id, {
        query: async () => ({ owner: REPLAY_OWNER_WALLET.address.toLowerCase() }),
      });
    }
    async apply(_chain: any, _state: any[]) {
      return [];
    }
    async attemptReplayIndexedPublicEvents(_chainId: string, stateDump: any[], indexedPublicEvents: any[]) {
      const firstReject = indexedPublicEvents.find((event) => event.eventType === 'reject');
      if (firstReject) {
        return {
          complete: false,
          stateDump,
          appliedEvents: [],
          appliedReplayKeys: [],
          duplicateReplayKeys: [],
          failure: { replayKey: `${firstReject.transactionHash}:${firstReject.logIndex}`, event: firstReject, cause: new Error('reject') },
        };
      }
      return {
        complete: true,
        stateDump,
        appliedEvents: indexedPublicEvents,
        appliedReplayKeys: indexedPublicEvents.map((event) => `${event.transactionHash}:${event.logIndex}`),
        duplicateReplayKeys: [],
      };
    }
    rpc(id: string) {
      return this.rpcStore.get(id);
    }
    clearRpc(_id: string) {}
  }

  return {
    calculateOwnablePackageCid: (entries: Array<{ path: string }>) => `cid-${entries.map((entry) => entry.path).sort().join('-')}`,
    evaluateReplayFreshness: (events: any[], appliedReplayKeys: string[]) => {
      const keys = events.map((event) => `${event.transactionHash}:${event.logIndex}`);
      const missingReplayKeys = keys.filter((key) => !appliedReplayKeys.includes(key));
      return { stale: missingReplayKeys.length > 0, missingReplayKeys };
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
  };
});

describe('OwnableService', () => {
  const buildConfig = () => ({
    getRuntimeNetworkProfile: () => 'testnet',
    getAuthoritySignerMnemonic: () => PRIVATE_STATE_OWNER_WALLET.mnemonic?.phrase || '',
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
      getOwnableByCid: jest.fn().mockResolvedValue({ id: 'id-1', cid: 'cid-1' }),
      getOwnableByNft: jest.fn(),
      listOwnableCidsByPrevOwner: jest.fn().mockResolvedValue(['cid-a']),
      listWalletEventsByCid: jest.fn().mockResolvedValue([]),
    };
    const notifyService = {
      notifyOwnableAvailability: jest.fn().mockResolvedValue({ status: 'delivered', ownerAccount: REPLAY_OWNER_WALLET.address.toLowerCase() }),
    };

    const service = new OwnableService(buildConfig() as any, nft as any, storage as any, hubState as any, notifyService as any);
    const runtimeValidatorSpy = jest
      .spyOn(service as any, 'assertSupportedOwnableRuntime')
      .mockImplementation(() => undefined);

    await service.onModuleInit();
    return { service, nft, storage, hubState, notifyService, runtimeValidatorSpy };
  };

  const createChain = async (nft = { network: 'eip155:base', address: '0xabc', id: '1' }) => {
    const chain = new EventChain(`0x${'11'.repeat(32)}`);
    const signer = {
      getAddress: async () => PRIVATE_STATE_OWNER_WALLET.address,
      signTypedData: async () => `0x${'00'.repeat(65)}`,
    };
    const event = new Event({ '@context': 'instantiate_msg.json', nft });
    event.previous = {
      toHex: () => `0x${'12'.repeat(32)}`,
    } as any;
    await event.addTo(chain).signWith(signer);
    return chain;
  };

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
    const { service, storage, hubState, nft, notifyService } = await buildService();
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
    expect(result.ownerAccount).toEqual(REPLAY_OWNER_WALLET.address.toLowerCase());
    expect(storage.storePackageArtifacts).toHaveBeenCalledTimes(1);
    expect(storage.storeEventChain).toHaveBeenCalledTimes(1);
    expect(hubState.upsertOwnableRecord).toHaveBeenCalledTimes(1);
    expect(nft.getOwnerOfNFT).not.toHaveBeenCalled();
    expect(hubState.setOwnerState).toHaveBeenCalledWith('id-1', REPLAY_OWNER_WALLET.address.toLowerCase(), null);
    expect(notifyService.notifyOwnableAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerKind: 'upload',
        cid: result.cid,
        ownerAddress: REPLAY_OWNER_WALLET.address.toLowerCase(),
        ownerNetwork: 'eip155:base',
      }),
    );
    expect(notifyService.notifyOwnableAvailability).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerAddress: PRIVATE_STATE_OWNER_WALLET.address.toLowerCase() }),
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
    expect(storage.storeEventChain).toHaveBeenCalledWith(result.cid, expect.any(Buffer));
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

  it('rejects ambiguous archives when chain aliases differ', async () => {
    const { service } = await buildService();
    const chain = await createChain();
    const buffer = await createUploadBuffer(chain, ['chain.json', 'eventChain.json'], {
      'eventChain.json': JSON.stringify({ ...chain.toJSON(), id: `0x${'22'.repeat(32)}` }),
    });

    await expect(service.uploadOwnable(buffer, undefined, false)).rejects.toThrow("Invalid package: 'chain.json' and 'eventChain.json' differ");
  });

  it('rejects wasm-bindgen runtime fixtures as invalid upload input', async () => {
    const { service, storage, hubState, notifyService, runtimeValidatorSpy } = await buildService();
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
    expect(notifyService.notifyOwnableAvailability).not.toHaveBeenCalled();
  });

  it('rejects wrong-kind raw-ABI exports before persistence', async () => {
    const { service, storage, hubState, notifyService, runtimeValidatorSpy } = await buildService();
    const chain = await createChain();
    const buffer = await createUploadBuffer(chain, ['chain.json'], {}, buildWrongKindRuntimeWasm());
    runtimeValidatorSpy.mockRestore();

    await expect(service.uploadOwnable(buffer, undefined, false)).rejects.toThrow(
      "Invalid package: unsupported Ownable runtime in 'ownable_bg.wasm'. Expected raw-ABI exports with no wasm imports; wrong raw-ABI export kinds: memory (expected memory, found global)",
    );
    expect(storage.storePackageArtifacts).not.toHaveBeenCalled();
    expect(storage.storeEventChain).not.toHaveBeenCalled();
    expect(hubState.upsertOwnableRecord).not.toHaveBeenCalled();
    expect(notifyService.notifyOwnableAvailability).not.toHaveBeenCalled();
  });

  it('delegates public replay to core service without persisting replay-derived owner state on download', async () => {
    const { service, storage, hubState, notifyService } = await buildService();
    const chain = await createChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');

    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    storage.getEventChain.mockResolvedValue(chainBuffer);
    hubState.listWalletEventsByCid.mockResolvedValue([
      {
        id: 'evt-1',
        eventKind: 'public',
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
        subjectId: chain.id,
        sourceAddress: '0x1111111111111111111111111111111111111111',
        eventType: 'ok',
        dataHex: '0x01',
        eventTimestamp: '1',
        payloadJson: {},
        indexedAt: new Date().toISOString(),
      },
    ]);

    const replaySpy = jest.spyOn(CoreOwnableService.prototype, 'attemptReplayIndexedPublicEvents');
    await service.downloadOwnable('cid-1');

    expect(replaySpy).toHaveBeenCalled();
    expect(hubState.setOwnerState).not.toHaveBeenCalled();
    expect(notifyService.notifyOwnableAvailability).not.toHaveBeenCalled();
  });

  it('does not read or publish download replay notify state when the archive is fresh', async () => {
    const { service, storage, hubState, notifyService } = await buildService();
    const chain = await createChain();

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listWalletEventsByCid.mockResolvedValue([]);

    await service.downloadOwnable('cid-1');

    expect(hubState.getOwnerStateByCid).not.toHaveBeenCalled();
    expect(notifyService.notifyOwnableAvailability).not.toHaveBeenCalled();
  });

  it('rejects stale ownables with stable stale error contract', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listWalletEventsByCid.mockResolvedValue([
      {
        id: 'evt-1',
        eventKind: 'public',
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
        subjectId: chain.id,
        sourceAddress: '0x1111111111111111111111111111111111111111',
        eventType: 'reject',
        dataHex: '0x01',
        eventTimestamp: '1',
        payloadJson: {},
        indexedAt: new Date().toISOString(),
      },
    ]);

    await expect(service.downloadOwnable('cid-1')).rejects.toThrow('STALE_OWNABLE');
  });

  it('preserves archive shape without synthesizing authority_claim_msg.json', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    const packageZip = new JSZip();
    packageZip.file('ownable_bg.wasm', Buffer.from([0x00]));
    packageZip.file('package.json', JSON.stringify({ name: 'pkg' }));
    storage.getPackageZip.mockResolvedValue(await packageZip.generateAsync({ type: 'nodebuffer' }));
    hubState.listWalletEventsByCid.mockResolvedValue([]);

    const file = await service.downloadOwnable('cid-1');
    const buffer = await toBuffer(file.getStream() as Readable);
    const outputZip = await new JSZip().loadAsync(buffer);

    expect(outputZip.file('chain.json')).toBeTruthy();
    expect(outputZip.file('eventChain.json')).toBeNull();
    expect(outputZip.file('authority_claim_msg.json')).toBeNull();
  });

  it('requires signer for unlock proof', async () => {
    const { service } = await buildService();
    await expect(service.getUnlockProof('cid-1')).rejects.toThrow('Missing SIWE signer');
  });
});
