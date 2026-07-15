import { Test } from '@nestjs/testing';
import { AnchorValidationService, PublicEventReplayService } from '@ownables/core';
import { OwnableReplayService } from './ownable-replay.service.js';

const mockEventChainDependencies: unknown[][] = [];
const mockOwnableDependencies: unknown[] = [];
const mockRuntimeSources: unknown[] = [];
const mockRuntimeRpcs: unknown[] = [];

jest.mock('@ownables/core', () => ({
  AnchorValidationService: class {},
  PublicEventReplayService: class {},
  EventChainService: class {
    constructor(...dependencies: unknown[]) {
      mockEventChainDependencies.push(dependencies);
    }
  },
  OwnableService: class {
    constructor(dependencies: unknown) {
      mockOwnableDependencies.push(dependencies);
    }
  },
}));

jest.mock('@ownables/platform-node', () => ({
  NodeRuntimeSourceProvider: class {
    constructor() {
      mockRuntimeSources.push(this);
    }
  },
  NodeRuntimeRpcProvider: class {
    constructor() {
      mockRuntimeRpcs.push(this);
    }
  },
}));

describe('OwnableReplayService', () => {
  const validateAgainstIndexedRecords = jest.fn();
  const key = jest.fn(
    (event: { transactionHash: string; logIndex: number }) => `${event.transactionHash}:${event.logIndex}`,
  );
  const evaluateFreshness = jest.fn();
  let service: OwnableReplayService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockEventChainDependencies.length = 0;
    mockOwnableDependencies.length = 0;
    mockRuntimeSources.length = 0;
    mockRuntimeRpcs.length = 0;
    const module = await Test.createTestingModule({
      providers: [
        OwnableReplayService,
        { provide: AnchorValidationService, useValue: { validateAgainstIndexedRecords } },
        { provide: PublicEventReplayService, useValue: { key, evaluateFreshness } },
      ],
    }).compile();
    service = module.get(OwnableReplayService);
  });

  it('forwards source-free indexed evidence to the injected validator', () => {
    const anchors = [{ key: { hex: '0x01' }, value: { hex: '0x02' } }];
    const records = [{ key: '0x01', value: '0x02', transactionHash: '0xtx' }];
    validateAgainstIndexedRecords.mockReturnValue({ verified: true });

    expect(service.validateAnchors(anchors, records as any)).toEqual({ verified: true });
    expect(validateAgainstIndexedRecords).toHaveBeenCalledWith(anchors, records);
  });

  it('uses injected replay policy after removing ignored events', () => {
    const events = [
      { transactionHash: '0xa', logIndex: 1 },
      { transactionHash: '0xb', logIndex: 2 },
    ];
    evaluateFreshness.mockReturnValue({ stale: false });

    expect(service.freshness(events as any, ['0xa:1'], new Set(['0xb:2']))).toEqual({ stale: false });
    expect(evaluateFreshness).toHaveBeenCalledWith([events[0]], ['0xa:1']);
  });

  it('constructs a distinct archive-scoped runtime graph with exact dependencies', () => {
    const stateStore = { state: true };
    const anchorProvider = { anchors: true };
    const packages = { package: true };

    const first = service.createRuntime(stateStore as any, anchorProvider as any, packages as any);
    const second = service.createRuntime(stateStore as any, anchorProvider as any, packages as any);

    expect(first).not.toEqual(second);
    expect(mockRuntimeSources).toHaveLength(2);
    expect(mockRuntimeRpcs).toHaveLength(2);
    expect(mockRuntimeSources[0]).not.toBe(mockRuntimeSources[1]);
    expect(mockRuntimeRpcs[0]).not.toBe(mockRuntimeRpcs[1]);
    expect(mockEventChainDependencies[0]).toEqual([stateStore, anchorProvider, expect.any(Object)]);
    expect(mockOwnableDependencies[0]).toEqual({
      stateStore,
      eventChains: first.eventChains,
      anchorProvider,
      packages,
      runtimeSource: mockRuntimeSources[0],
      runtimeRpc: mockRuntimeRpcs[0],
      replay: expect.objectContaining({ key, evaluateFreshness }),
      logger: console,
    });
  });
});
