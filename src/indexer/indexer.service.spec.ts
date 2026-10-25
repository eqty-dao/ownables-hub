import { ConfigService } from '../common/config/config.service';
import { HubStateRepository } from '../persistence/repos/hub-state.repository';
import { IndexerService } from './indexer.service';
import { Interface, JsonRpcProvider } from 'ethers';
import { OwnableTransportService } from '../ownable/ownable-transport.service';
import { Test, type TestingModule } from '@nestjs/testing';
import { EVM_RPC_PROVIDER_FACTORY } from './indexer.tokens';

const providerState = {
  head: 0,
  logs: [] as any[],
  getLogs: undefined as ((fromBlock: number, toBlock: number) => any[]) | undefined,
};

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    JsonRpcProvider: jest.fn().mockImplementation(() => ({
      getBlockNumber: jest.fn(async () => providerState.head),
      getLogs: jest.fn(async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) =>
        providerState.getLogs ? providerState.getLogs(fromBlock, toBlock) : providerState.logs,
      ),
    })),
  };
});

describe('IndexerService', () => {
  const configService = {
    getIndexerSlots: jest.fn(),
  } as unknown as ConfigService;

  const hubStateRepository = {
    getIndexerCursor: jest.fn(),
    withIndexerPersistenceTransaction: jest.fn(),
  } as unknown as HubStateRepository;

  const ownableTransport = {
    publishPublicEvent: jest.fn(),
  } as unknown as OwnableTransportService;

  let service: IndexerService;
  let module: TestingModule;
  const providerFactory = jest.fn(() => new JsonRpcProvider());

  beforeEach(async () => {
    providerState.head = 0;
    providerState.logs = [];
    providerState.getLogs = undefined;
    (configService.getIndexerSlots as jest.Mock).mockReset();
    (hubStateRepository.getIndexerCursor as jest.Mock).mockReset();
    (hubStateRepository.withIndexerPersistenceTransaction as jest.Mock).mockReset();
    (ownableTransport.publishPublicEvent as jest.Mock).mockReset();
    providerFactory.mockClear();
    module = await Test.createTestingModule({
      providers: [
        IndexerService,
        { provide: ConfigService, useValue: configService },
        { provide: HubStateRepository, useValue: hubStateRepository },
        { provide: OwnableTransportService, useValue: ownableTransport },
        { provide: EVM_RPC_PROVIDER_FACTORY, useValue: providerFactory },
      ],
    }).compile();
    service = module.get(IndexerService);
  });

  afterEach(async () => module.close());

  it('runs both slots in deterministic order', async () => {
    const runSlotSpy = jest.spyOn(service, 'runSlot').mockResolvedValue();
    (configService.getIndexerSlots as jest.Mock).mockReturnValue([
      {
        slotName: 'testnet',
        chainId: '84532',
        rpcUrl: 'https://testnet-rpc',
        anchorContractAddress: '0x1111111111111111111111111111111111111111',
        anchorStartBlock: 10n,
      },
      {
        slotName: 'mainnet',
        chainId: '8453',
        rpcUrl: 'https://mainnet-rpc',
        anchorContractAddress: '0x2222222222222222222222222222222222222222',
        anchorStartBlock: 20n,
      },
    ]);

    await service.runAllSlots();

    expect(runSlotSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ slotName: 'testnet' }));
    expect(runSlotSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ slotName: 'mainnet' }));
  });

  it('persists anchor/public events and advances cursor from start block when no cursor exists', async () => {
    const iface = new Interface([
      'event Anchored(bytes32 indexed key, bytes32 value, address indexed sender, uint64 timestamp)',
      'event PublicEvent(bytes32 indexed subjectId, address indexed source, string eventType, bytes data, uint64 timestamp)',
    ]);
    const anchoredLog = iface.encodeEventLog(iface.getEvent('Anchored'), [
      '0x' + '2'.repeat(64),
      '0x' + '3'.repeat(64),
      '0x00000000000000000000000000000000000000aa',
      41n,
    ]);
    const publicLog = iface.encodeEventLog(iface.getEvent('PublicEvent'), [
      '0x' + '1'.repeat(64),
      '0x00000000000000000000000000000000000000bb',
      'transfer',
      '0x12345678abcdef',
      42n,
    ]);

    providerState.head = 102;
    providerState.logs = [
      {
        blockNumber: 101,
        blockHash: '0xb2',
        transactionHash: '0xt2',
        transactionIndex: 1,
        index: 0,
        address: '0x1111111111111111111111111111111111111111',
        topics: anchoredLog.topics,
        data: anchoredLog.data,
      },
      {
        blockNumber: 101,
        blockHash: '0xb2',
        transactionHash: '0xt1',
        transactionIndex: 0,
        index: 1,
        address: '0x1111111111111111111111111111111111111111',
        topics: publicLog.topics,
        data: publicLog.data,
      },
    ];

    (hubStateRepository.getIndexerCursor as jest.Mock).mockResolvedValue(null);

    await service.runSlot({
      slotName: 'testnet',
      chainId: '84532',
      rpcUrl: 'https://testnet-rpc',
      anchorContractAddress: '0x1111111111111111111111111111111111111111',
      anchorStartBlock: 100n,
    });

    expect(providerFactory).toHaveBeenCalledWith(expect.objectContaining({ slotName: 'testnet' }));

    expect(hubStateRepository.getIndexerCursor).toHaveBeenCalledWith(
      'testnet',
      'anchor-public-events',
      '84532',
      '0x1111111111111111111111111111111111111111',
    );
    expect(hubStateRepository.withIndexerPersistenceTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        slotName: 'testnet',
        nextFromBlock: 103n,
        lastScannedBlock: 102n,
        lastScannedTxHash: '0xt2',
        lastScannedTxIndex: 1,
        lastScannedLogIndex: 0,
      }),
    );

    const input = (hubStateRepository.withIndexerPersistenceTransaction as jest.Mock).mock.calls[0][0];
    expect(input.anchorEvents).toHaveLength(1);
    expect(input.publicEvents).toHaveLength(1);
    expect(input.anchorEvents[0].transactionIndex).toBe(1);
    expect(input.anchorEvents[0]).toMatchObject({
      cid: null,
      ownerAddress: '0x00000000000000000000000000000000000000aa',
      payloadJson: {
        key: `0x${'2'.repeat(64)}`,
        value: `0x${'3'.repeat(64)}`,
        ownerAddress: '0x00000000000000000000000000000000000000aa',
        timestamp: '41',
      },
    });
    expect(input.publicEvents[0].transactionIndex).toBe(0);
    expect(input.publicEvents[0]).toMatchObject({
      subjectId: `0x${'1'.repeat(64)}`,
      sourceAddress: '0x00000000000000000000000000000000000000bb',
      eventType: 'transfer',
      dataHex: '0x12345678abcdef',
      eventTimestamp: 42n,
    });
    expect(ownableTransport.publishPublicEvent).toHaveBeenCalledWith({
      subjectId: `0x${'1'.repeat(64)}`,
      slotName: 'testnet',
      chainId: '84532',
      anchorContractAddress: '0x1111111111111111111111111111111111111111',
      publicEvent: {
        source: '0x00000000000000000000000000000000000000bb',
        eventType: 'transfer',
        data: '0x12345678abcdef',
        blockNumber: 101,
        transactionHash: '0xt1',
        transactionIndex: 0,
        logIndex: 1,
        timestamp: 42,
      },
    });
  });

  it('starts at the current anchor start block when only another anchor partition exists', async () => {
    providerState.head = 40;
    (hubStateRepository.getIndexerCursor as jest.Mock).mockResolvedValue({
      slotName: 'testnet',
      cursorName: 'anchor-public-events',
      chainId: '84532',
      anchorContractAddress: '0x00000000000000000000000000000000000000aa',
      nextFromBlock: 26n,
      lastScannedBlock: 25n,
      lastScannedTxHash: '0xold',
      lastScannedTxIndex: 0,
      lastScannedLogIndex: 0,
    });

    await service.runSlot({
      slotName: 'testnet',
      chainId: '84532',
      rpcUrl: 'https://base-sepolia-rpc',
      anchorContractAddress: '0xe518BB784B8cB17e6F16e445A9275A16d61700b5',
      anchorStartBlock: 35n,
    });

    expect(hubStateRepository.getIndexerCursor).toHaveBeenCalledWith(
      'testnet',
      'anchor-public-events',
      '84532',
      '0xe518BB784B8cB17e6F16e445A9275A16d61700b5',
    );
    const provider = (jest.requireMock('ethers').JsonRpcProvider as jest.Mock).mock.results.at(-1)?.value;
    expect(provider.getLogs).toHaveBeenCalledWith({
      address: '0xe518BB784B8cB17e6F16e445A9275A16d61700b5',
      fromBlock: 35,
      toBlock: 40,
    });
    expect(hubStateRepository.withIndexerPersistenceTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0xe518BB784B8cB17e6F16e445A9275A16d61700b5',
        nextFromBlock: 41n,
      }),
    );
  });

  it('resumes from cursor next block and remains idempotent across reruns', async () => {
    providerState.head = 120;
    providerState.logs = [];
    (hubStateRepository.getIndexerCursor as jest.Mock).mockResolvedValue({
      slotName: 'mainnet',
      cursorName: 'anchor-public-events',
      chainId: '8453',
      anchorContractAddress: '0x2222222222222222222222222222222222222222',
      nextFromBlock: 121n,
      lastScannedBlock: 120n,
      lastScannedTxHash: '0xold',
      lastScannedTxIndex: 2,
      lastScannedLogIndex: 5,
    });

    await service.runSlot({
      slotName: 'mainnet',
      chainId: '8453',
      rpcUrl: 'https://mainnet-rpc',
      anchorContractAddress: '0x2222222222222222222222222222222222222222',
      anchorStartBlock: 10n,
    });

    expect(hubStateRepository.withIndexerPersistenceTransaction).not.toHaveBeenCalled();
  });

  it('resumes within current head range and advances cursor from the resumed window', async () => {
    const iface = new Interface([
      'event Anchored(bytes32 indexed key, bytes32 value, address indexed sender, uint64 timestamp)',
      'event PublicEvent(bytes32 indexed subjectId, address indexed source, string eventType, bytes data, uint64 timestamp)',
    ]);
    const anchoredLog = iface.encodeEventLog(iface.getEvent('Anchored'), [
      '0x' + '4'.repeat(64),
      '0x' + '5'.repeat(64),
      '0x00000000000000000000000000000000000000aa',
      99n,
    ]);

    providerState.head = 120;
    providerState.logs = [
      {
        blockNumber: 116,
        blockHash: '0xb116',
        transactionHash: '0xt116',
        transactionIndex: 2,
        index: 3,
        address: '0x1111111111111111111111111111111111111111',
        topics: anchoredLog.topics,
        data: anchoredLog.data,
      },
    ];

    (hubStateRepository.getIndexerCursor as jest.Mock).mockResolvedValue({
      slotName: 'testnet',
      cursorName: 'anchor-public-events',
      chainId: '84532',
      anchorContractAddress: '0x1111111111111111111111111111111111111111',
      nextFromBlock: 115n,
      lastScannedBlock: 114n,
      lastScannedTxHash: '0xprev',
      lastScannedTxIndex: 1,
      lastScannedLogIndex: 9,
    });

    await service.runSlot({
      slotName: 'testnet',
      chainId: '84532',
      rpcUrl: 'https://testnet-rpc',
      anchorContractAddress: '0x1111111111111111111111111111111111111111',
      anchorStartBlock: 100n,
    });

    expect(hubStateRepository.withIndexerPersistenceTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        slotName: 'testnet',
        nextFromBlock: 121n,
        lastScannedBlock: 120n,
        lastScannedTxHash: '0xt116',
        lastScannedTxIndex: 2,
        lastScannedLogIndex: 3,
      }),
    );
  });

  it('commits each 2000-block log window before fetching the next one', async () => {
    const iface = new Interface([
      'event PublicEvent(bytes32 indexed subjectId, address indexed source, string eventType, bytes data, uint64 timestamp)',
    ]);
    providerState.head = 4_205;
    (hubStateRepository.getIndexerCursor as jest.Mock).mockResolvedValue(null);
    providerState.getLogs = (_fromBlock, toBlock) => {
      const encoded = iface.encodeEventLog(iface.getEvent('PublicEvent'), [
        `0x${toBlock.toString(16).padStart(64, '0')}`,
        '0x00000000000000000000000000000000000000bb',
        'transfer',
        '0x1234',
        BigInt(toBlock),
      ]);
      return [
        {
          blockNumber: toBlock,
          blockHash: `0xb${toBlock}`,
          transactionHash: `0xt${toBlock}`,
          transactionIndex: 0,
          index: 0,
          address: '0x1111111111111111111111111111111111111111',
          topics: encoded.topics,
          data: encoded.data,
        },
      ];
    };

    await service.runSlot({
      slotName: 'testnet',
      chainId: '84532',
      rpcUrl: 'https://base-sepolia-rpc',
      anchorContractAddress: '0x1111111111111111111111111111111111111111',
      anchorStartBlock: 1_000n,
    });

    const provider = (jest.requireMock('ethers').JsonRpcProvider as jest.Mock).mock.results.at(-1)?.value;
    expect(provider.getLogs.mock.calls).toEqual([
      [{ address: '0x1111111111111111111111111111111111111111', fromBlock: 1_000, toBlock: 2_999 }],
      [{ address: '0x1111111111111111111111111111111111111111', fromBlock: 3_000, toBlock: 4_205 }],
    ]);
    expect(hubStateRepository.withIndexerPersistenceTransaction).toHaveBeenCalledTimes(2);
    expect(hubStateRepository.withIndexerPersistenceTransaction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        nextFromBlock: 3_000n,
        lastScannedBlock: 2_999n,
        publicEvents: [expect.objectContaining({ blockNumber: 2_999n })],
      }),
    );
    expect(hubStateRepository.withIndexerPersistenceTransaction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        nextFromBlock: 4_206n,
        lastScannedBlock: 4_205n,
        publicEvents: [expect.objectContaining({ blockNumber: 4_205n })],
      }),
    );
  });

  it('advances cursor across successive runs/windows', async () => {
    (hubStateRepository.getIndexerCursor as jest.Mock)
      .mockResolvedValueOnce({
        slotName: 'mainnet',
        cursorName: 'anchor-public-events',
        chainId: '8453',
        anchorContractAddress: '0x2222222222222222222222222222222222222222',
        nextFromBlock: 201n,
        lastScannedBlock: 200n,
        lastScannedTxHash: '0x200',
        lastScannedTxIndex: 0,
        lastScannedLogIndex: 0,
      })
      .mockResolvedValueOnce({
        slotName: 'mainnet',
        cursorName: 'anchor-public-events',
        chainId: '8453',
        anchorContractAddress: '0x2222222222222222222222222222222222222222',
        nextFromBlock: 206n,
        lastScannedBlock: 205n,
        lastScannedTxHash: '0x205',
        lastScannedTxIndex: 1,
        lastScannedLogIndex: 0,
      });

    providerState.head = 205;
    providerState.logs = [];
    await service.runSlot({
      slotName: 'mainnet',
      chainId: '8453',
      rpcUrl: 'https://mainnet-rpc',
      anchorContractAddress: '0x2222222222222222222222222222222222222222',
      anchorStartBlock: 10n,
    });

    providerState.head = 210;
    providerState.logs = [];
    await service.runSlot({
      slotName: 'mainnet',
      chainId: '8453',
      rpcUrl: 'https://mainnet-rpc',
      anchorContractAddress: '0x2222222222222222222222222222222222222222',
      anchorStartBlock: 10n,
    });

    expect(hubStateRepository.withIndexerPersistenceTransaction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ slotName: 'mainnet', nextFromBlock: 206n, lastScannedBlock: 205n }),
    );
    expect(hubStateRepository.withIndexerPersistenceTransaction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ slotName: 'mainnet', nextFromBlock: 211n, lastScannedBlock: 210n }),
    );
  });

  it.each([
    [99n, false],
    [100n, false],
    [101n, true],
    [102n, true],
  ])('uses an existing cursor when configured start is %s', async (anchorStartBlock, shouldFail) => {
    providerState.head = 120;
    (hubStateRepository.getIndexerCursor as jest.Mock).mockResolvedValue({
      slotName: 'testnet',
      cursorName: 'anchor-public-events',
      chainId: '84532',
      anchorContractAddress: '0x1111111111111111111111111111111111111111',
      nextFromBlock: 101n,
      lastScannedBlock: 100n,
      lastScannedTxHash: null,
      lastScannedTxIndex: null,
      lastScannedLogIndex: null,
    });

    const run = service.runSlot({
      slotName: 'testnet',
      chainId: '84532',
      rpcUrl: 'https://testnet-rpc',
      anchorContractAddress: '0x1111111111111111111111111111111111111111',
      anchorStartBlock,
    });

    if (shouldFail) {
      await expect(run).rejects.toThrow('above the last committed processed block 100');
      expect(providerFactory).not.toHaveBeenCalled();
      expect(hubStateRepository.withIndexerPersistenceTransaction).not.toHaveBeenCalled();
      return;
    }

    await run;
    const provider = (jest.requireMock('ethers').JsonRpcProvider as jest.Mock).mock.results.at(-1)?.value;
    expect(provider.getLogs).toHaveBeenCalledWith({
      address: '0x1111111111111111111111111111111111111111',
      fromBlock: 101,
      toBlock: 120,
    });
  });

  it('resumes a case-insensitive cursor identity at its committed next block', async () => {
    providerState.head = 120;
    (hubStateRepository.getIndexerCursor as jest.Mock).mockResolvedValue({
      slotName: 'testnet',
      cursorName: 'anchor-public-events',
      chainId: '84532',
      anchorContractAddress: '0xE518BB784B8cB17e6F16e445A9275A16d61700b5',
      nextFromBlock: 101n,
      lastScannedBlock: 100n,
      lastScannedTxHash: null,
      lastScannedTxIndex: null,
      lastScannedLogIndex: null,
    });

    await service.runSlot({
      slotName: 'testnet',
      chainId: '84532',
      rpcUrl: 'https://testnet-rpc',
      anchorContractAddress: '0xe518bb784b8cb17e6f16e445a9275a16d61700b5',
      anchorStartBlock: 100n,
    });

    const provider = (jest.requireMock('ethers').JsonRpcProvider as jest.Mock).mock.results.at(-1)?.value;
    expect(provider.getLogs).toHaveBeenCalledWith({
      address: '0xe518bb784b8cb17e6f16e445a9275a16d61700b5',
      fromBlock: 101,
      toBlock: 120,
    });
  });

  it('keeps the first committed window and resumes from the failed window', async () => {
    providerState.head = 5_200;
    let nextFromBlock = 1_000n;
    let transactionAttempt = 0;
    (hubStateRepository.getIndexerCursor as jest.Mock).mockImplementation(async () => ({
      slotName: 'testnet',
      cursorName: 'anchor-public-events',
      chainId: '84532',
      anchorContractAddress: '0x1111111111111111111111111111111111111111',
      nextFromBlock,
      lastScannedBlock: nextFromBlock - 1n,
      lastScannedTxHash: null,
      lastScannedTxIndex: null,
      lastScannedLogIndex: null,
    }));
    (hubStateRepository.withIndexerPersistenceTransaction as jest.Mock).mockImplementation(async (input) => {
      transactionAttempt += 1;
      if (transactionAttempt === 2) {
        throw new Error('database unavailable');
      }
      nextFromBlock = input.nextFromBlock;
    });

    const slot = {
      slotName: 'testnet' as const,
      chainId: '84532',
      rpcUrl: 'https://testnet-rpc',
      anchorContractAddress: '0x1111111111111111111111111111111111111111',
      anchorStartBlock: 999n,
    };
    await expect(service.runSlot(slot)).rejects.toThrow('database unavailable');

    const firstProvider = (jest.requireMock('ethers').JsonRpcProvider as jest.Mock).mock.results.at(-1)?.value;
    expect(firstProvider.getLogs.mock.calls).toEqual([
      [{ address: slot.anchorContractAddress, fromBlock: 1_000, toBlock: 2_999 }],
      [{ address: slot.anchorContractAddress, fromBlock: 3_000, toBlock: 4_999 }],
    ]);
    expect(nextFromBlock).toBe(3_000n);

    transactionAttempt = 0;
    (hubStateRepository.withIndexerPersistenceTransaction as jest.Mock).mockImplementation(async (input) => {
      nextFromBlock = input.nextFromBlock;
    });
    await service.runSlot(slot);

    const restartedProvider = (jest.requireMock('ethers').JsonRpcProvider as jest.Mock).mock.results.at(-1)?.value;
    expect(restartedProvider.getLogs.mock.calls).toEqual([
      [{ address: slot.anchorContractAddress, fromBlock: 3_000, toBlock: 4_999 }],
      [{ address: slot.anchorContractAddress, fromBlock: 5_000, toBlock: 5_200 }],
    ]);
    expect(nextFromBlock).toBe(5_201n);
  });

  it('does not persist cursor when transactional write fails', async () => {
    providerState.head = 100;
    providerState.logs = [];
    (hubStateRepository.getIndexerCursor as jest.Mock).mockResolvedValue(null);
    (hubStateRepository.withIndexerPersistenceTransaction as jest.Mock).mockRejectedValue(new Error('write failed'));

    await expect(
      service.runSlot({
        slotName: 'testnet',
        chainId: '84532',
        rpcUrl: 'https://testnet-rpc',
        anchorContractAddress: '0x1111111111111111111111111111111111111111',
        anchorStartBlock: 100n,
      }),
    ).rejects.toThrow('write failed');

    expect(hubStateRepository.withIndexerPersistenceTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not publish public events from a window whose transaction fails', async () => {
    const iface = new Interface([
      'event PublicEvent(bytes32 indexed subjectId, address indexed source, string eventType, bytes data, uint64 timestamp)',
    ]);
    const encoded = iface.encodeEventLog(iface.getEvent('PublicEvent'), [
      `0x${'1'.repeat(64)}`,
      '0x00000000000000000000000000000000000000bb',
      'transfer',
      '0x1234',
      42n,
    ]);
    providerState.head = 100;
    providerState.logs = [
      {
        blockNumber: 100,
        blockHash: '0xb100',
        transactionHash: '0xt100',
        transactionIndex: 0,
        index: 0,
        address: '0x1111111111111111111111111111111111111111',
        topics: encoded.topics,
        data: encoded.data,
      },
    ];
    (hubStateRepository.getIndexerCursor as jest.Mock).mockResolvedValue(null);
    (hubStateRepository.withIndexerPersistenceTransaction as jest.Mock).mockRejectedValue(new Error('write failed'));

    await expect(
      service.runSlot({
        slotName: 'testnet',
        chainId: '84532',
        rpcUrl: 'https://testnet-rpc',
        anchorContractAddress: '0x1111111111111111111111111111111111111111',
        anchorStartBlock: 100n,
      }),
    ).rejects.toThrow('write failed');

    expect(ownableTransport.publishPublicEvent).not.toHaveBeenCalled();
  });
});
