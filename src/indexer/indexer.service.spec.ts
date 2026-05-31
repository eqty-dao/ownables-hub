import { ConfigService } from '../common/config/config.service.js';
import { HubStateRepository } from '../persistence/repos/hub-state.repository.js';
import { IndexerService } from './indexer.service.js';
import { Interface } from 'ethers';

const providerState = {
  head: 0,
  logs: [] as any[],
};

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    JsonRpcProvider: jest.fn().mockImplementation(() => ({
      getBlockNumber: jest.fn(async () => providerState.head),
      getLogs: jest.fn(async () => providerState.logs),
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

  let service: IndexerService;

  beforeEach(() => {
    providerState.head = 0;
    providerState.logs = [];
    (configService.getIndexerSlots as jest.Mock).mockReset();
    (hubStateRepository.getIndexerCursor as jest.Mock).mockReset();
    (hubStateRepository.withIndexerPersistenceTransaction as jest.Mock).mockReset();
    service = new IndexerService(configService, hubStateRepository);
  });

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
      'event Anchored(bytes32 indexed cidHash, string cid, address indexed owner)',
      'event PublicEvent(bytes32 indexed cidHash, string cid, address indexed owner, bytes payload)',
    ]);
    const anchoredLog = iface.encodeEventLog(iface.getEvent('Anchored'), [
      '0x' + '0'.repeat(64),
      'cid-1',
      '0x00000000000000000000000000000000000000aa',
    ]);
    const publicLog = iface.encodeEventLog(iface.getEvent('PublicEvent'), [
      '0x' + '0'.repeat(64),
      'cid-2',
      '0x00000000000000000000000000000000000000bb',
      '0x12345678',
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

    expect(hubStateRepository.getIndexerCursor).toHaveBeenCalledWith('testnet', 'anchor-public-events');
    expect(hubStateRepository.withIndexerPersistenceTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        slotName: 'testnet',
        nextFromBlock: 103n,
        lastScannedBlock: 101n,
        lastScannedTxHash: '0xt2',
        lastScannedTxIndex: 1,
        lastScannedLogIndex: 0,
      }),
    );

    const input = (hubStateRepository.withIndexerPersistenceTransaction as jest.Mock).mock.calls[0][0];
    expect(input.anchorEvents).toHaveLength(1);
    expect(input.publicEvents).toHaveLength(1);
    expect(input.anchorEvents[0].transactionIndex).toBe(1);
    expect(input.publicEvents[0].transactionIndex).toBe(0);
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
});
