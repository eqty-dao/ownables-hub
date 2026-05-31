import { HubStateRepository } from './hub-state.repository.js';

describe('HubStateRepository', () => {
  const query = jest.fn();
  const withClient = jest.fn();
  const db = { query, withClient };
  let repo: HubStateRepository;

  beforeEach(() => {
    query.mockReset();
    withClient.mockReset();
    repo = new HubStateRepository(db as any);
  });

  it('upserts and resolves ownable lookups by cid and nft', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'own-1', cid: 'cid-1', prevOwnerAddress: '0xabc' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'own-1', cid: 'cid-1', prevOwnerAddress: '0xabc' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'own-1', cid: 'cid-1', prevOwnerAddress: '0xabc' }] });

    await repo.upsertOwnableRecord({
      cid: 'cid-1',
      prevOwnerAddress: '0xABC',
      nftNetwork: 'eip155:base',
      nftContractAddress: '0xNFT',
      nftTokenId: '1',
    });

    const byCid = await repo.getOwnableByCid('cid-1');
    const byNft = await repo.getOwnableByNft('eip155:base', '0xNFT', '1');

    expect(byCid?.cid).toBe('cid-1');
    expect(byNft?.id).toBe('own-1');
  });

  it('reads bridged cid list by previous owner', async () => {
    query.mockResolvedValueOnce({ rows: [{ cid: 'cid-1' }, { cid: 'cid-2' }] });

    const cids = await repo.listOwnableCidsByPrevOwner('0xOwner');

    expect(cids).toEqual(['cid-1', 'cid-2']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('prev_owner_address = LOWER($1)'), ['0xOwner']);
  });

  it('writes owner state with versioning increment path and reads by cid', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ owner: '0xowner', version: 3 }] });

    await repo.setOwnerState('own-1', '0xOWNER', 'evt-1');
    const state = await repo.getOwnerStateByCid('cid-1');

    expect(state).toEqual({ owner: '0xowner', version: 3 });
  });

  it('upserts and reads indexer cursor state including tx index', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({
      rows: [
        {
          slotName: 'testnet',
          cursorName: 'anchor',
          chainId: '84532',
          anchorContractAddress: '0xAnchor',
          nextFromBlock: '10',
          lastScannedBlock: '9',
          lastScannedTxHash: '0xTx',
          lastScannedTxIndex: 3,
          lastScannedLogIndex: 7,
        },
      ],
    });

    await repo.upsertIndexerCursor({
      slotName: 'testnet',
      cursorName: 'anchor',
      chainId: '84532',
      anchorContractAddress: '0xAnchor',
      nextFromBlock: 10n,
      lastScannedBlock: 9n,
      lastScannedTxHash: '0xTx',
      lastScannedTxIndex: 3,
      lastScannedLogIndex: 7,
    });
    const cursor = await repo.getIndexerCursor('testnet', 'anchor');

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO indexer_cursors'),
      ['testnet', 'anchor', '84532', '0xAnchor', '10', '9', '0xTx', 3, 7],
    );
    expect(cursor?.nextFromBlock).toBe(10n);
    expect(cursor?.lastScannedTxIndex).toBe(3);
  });

  it('upserts indexed events with transaction ordering metadata', async () => {
    query.mockResolvedValue({ rows: [] });

    await repo.upsertIndexedAnchorEvent({
      slotName: 'testnet',
      chainId: '84532',
      anchorContractAddress: '0xA1',
      blockNumber: 25n,
      blockHash: '0xB1',
      transactionHash: '0xC1',
      transactionIndex: 2,
      logIndex: 4,
      eventName: 'Anchored',
      cid: 'cid-1',
      ownableId: 'oid-1',
      ownerAddress: '0xD1',
      payloadJson: { key: 'value' },
    });

    await repo.upsertIndexedPublicEvent({
      slotName: 'mainnet',
      chainId: '8453',
      anchorContractAddress: '0xA2',
      blockNumber: 26n,
      blockHash: '0xB2',
      transactionHash: '0xC2',
      transactionIndex: 1,
      logIndex: 5,
      eventName: 'PublicEvent',
      payloadJson: { key: 'value' },
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO indexed_anchor_events'),
      expect.arrayContaining(['testnet', '84532', '0xA1', '25', '0xB1', '0xC1', 2, 4]),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO indexed_public_events'),
      expect.arrayContaining(['mainnet', '8453', '0xA2', '26', '0xB2', '0xC2', 1, 5]),
    );
  });

  it('uses slot-scoped duplicate upsert key for indexed events', async () => {
    query.mockResolvedValue({ rows: [] });

    await repo.upsertIndexedAnchorEvent({
      slotName: 'testnet',
      chainId: '84532',
      anchorContractAddress: '0xA1',
      blockNumber: 25n,
      blockHash: '0xB1',
      transactionHash: '0xDUP',
      transactionIndex: 2,
      logIndex: 4,
      eventName: 'Anchored',
      cid: 'cid-1',
      ownableId: 'oid-1',
      ownerAddress: '0xD1',
      payloadJson: { key: 'value' },
    });

    await repo.upsertIndexedPublicEvent({
      slotName: 'mainnet',
      chainId: '8453',
      anchorContractAddress: '0xA2',
      blockNumber: 26n,
      blockHash: '0xB2',
      transactionHash: '0xDUP',
      transactionIndex: 1,
      logIndex: 4,
      eventName: 'PublicEvent',
      payloadJson: { key: 'value' },
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('ON CONFLICT (slot_name, transaction_hash, log_index) DO UPDATE SET'),
      expect.any(Array),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ON CONFLICT (slot_name, transaction_hash, log_index) DO UPDATE SET'),
      expect.any(Array),
    );
  });

  it('queries wallet export events ordered by block, transaction_index, and log_index', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: '1', eventKind: 'anchor' }] });

    const rows = await repo.listWalletEventsByCid('cid-abc');

    expect(rows).toEqual([{ id: '1', eventKind: 'anchor' }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY "blockNumber"::numeric ASC, "transactionIndex" ASC, "logIndex" ASC'), ['cid-abc']);
  });

  it('commits transaction after persisting events and cursor', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    withClient.mockImplementation(async (fn: (client: any) => Promise<void>) => fn({ query: clientQuery }));

    await repo.withIndexerPersistenceTransaction({
      slotName: 'testnet',
      cursorName: 'anchor',
      chainId: '84532',
      anchorContractAddress: '0xAnchor',
      nextFromBlock: 12n,
      lastScannedBlock: 11n,
      lastScannedTxHash: '0xTx',
      lastScannedTxIndex: 1,
      lastScannedLogIndex: 2,
      anchorEvents: [],
      publicEvents: [],
    });

    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO indexer_cursors'), expect.any(Array));
    expect(clientQuery).toHaveBeenLastCalledWith('COMMIT');
  });

  it('isolates cursor writes by slot between testnet and mainnet', async () => {
    query.mockResolvedValue({ rows: [] });
    query
      .mockResolvedValueOnce({ rows: [{ nextFromBlock: '51', slotName: 'testnet' }] })
      .mockResolvedValueOnce({ rows: [{ nextFromBlock: '101', slotName: 'mainnet' }] });

    await repo.upsertIndexerCursor({
      slotName: 'testnet',
      cursorName: 'anchor-public-events',
      chainId: '84532',
      anchorContractAddress: '0xAnchor1',
      nextFromBlock: 51n,
    });
    await repo.upsertIndexerCursor({
      slotName: 'mainnet',
      cursorName: 'anchor-public-events',
      chainId: '8453',
      anchorContractAddress: '0xAnchor2',
      nextFromBlock: 101n,
    });
    await repo.getIndexerCursor('testnet', 'anchor-public-events');
    await repo.getIndexerCursor('mainnet', 'anchor-public-events');

    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('WHERE slot_name = $1 AND cursor_name = $2'),
      ['testnet', 'anchor-public-events'],
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('WHERE slot_name = $1 AND cursor_name = $2'),
      ['mainnet', 'anchor-public-events'],
    );
  });

  it('persists and rereads cursor across successive advances', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({
      rows: [
        {
          slotName: 'testnet',
          cursorName: 'anchor-public-events',
          chainId: '84532',
          anchorContractAddress: '0xAnchor',
          nextFromBlock: '30',
          lastScannedBlock: '29',
          lastScannedTxHash: '0x29',
          lastScannedTxIndex: 1,
          lastScannedLogIndex: 2,
        },
      ],
    });

    await repo.upsertIndexerCursor({
      slotName: 'testnet',
      cursorName: 'anchor-public-events',
      chainId: '84532',
      anchorContractAddress: '0xAnchor',
      nextFromBlock: 20n,
      lastScannedBlock: 19n,
      lastScannedTxHash: '0x19',
      lastScannedTxIndex: 0,
      lastScannedLogIndex: 1,
    });
    await repo.upsertIndexerCursor({
      slotName: 'testnet',
      cursorName: 'anchor-public-events',
      chainId: '84532',
      anchorContractAddress: '0xAnchor',
      nextFromBlock: 30n,
      lastScannedBlock: 29n,
      lastScannedTxHash: '0x29',
      lastScannedTxIndex: 1,
      lastScannedLogIndex: 2,
    });

    const cursor = await repo.getIndexerCursor('testnet', 'anchor-public-events');
    expect(cursor?.nextFromBlock).toBe(30n);
    expect(cursor?.lastScannedBlock).toBe(29n);
    expect(cursor?.lastScannedTxIndex).toBe(1);
    expect(cursor?.lastScannedLogIndex).toBe(2);
  });

  it('rolls back transaction when event persistence fails', async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce({ rows: [] });
    withClient.mockImplementation(async (fn: (client: any) => Promise<void>) => fn({ query: clientQuery }));

    await expect(
      repo.withIndexerPersistenceTransaction({
        slotName: 'mainnet',
        cursorName: 'anchor',
        chainId: '8453',
        anchorContractAddress: '0xAnchor',
        nextFromBlock: 20n,
        anchorEvents: [
          {
            slotName: 'mainnet',
            chainId: '8453',
            anchorContractAddress: '0xAnchor',
            blockNumber: 19n,
            blockHash: '0xB',
            transactionHash: '0xT',
            transactionIndex: 0,
            logIndex: 0,
            eventName: 'Anchored',
            payloadJson: {},
          },
        ],
        publicEvents: [],
      }),
    ).rejects.toThrow('insert failed');

    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });
});
