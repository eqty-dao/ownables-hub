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

  it('upserts and resolves ownable lookups by cid, nft, and subject', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'own-1', cid: 'cid-1', prevOwnerAddress: '0xabc', subjectId: '0x11' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'own-1', cid: 'cid-1', prevOwnerAddress: '0xabc', subjectId: '0x11' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'own-1', cid: 'cid-1', prevOwnerAddress: '0xabc', subjectId: '0x11' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'own-1', cid: 'cid-1', prevOwnerAddress: '0xabc', subjectId: '0x11' }] });

    await repo.upsertOwnableRecord({
      cid: 'cid-1',
      prevOwnerAddress: '0xABC',
      subjectId: '0x11',
      nftNetwork: 'eip155:base',
      nftContractAddress: '0xNFT',
      nftTokenId: '1',
    });

    const byCid = await repo.getOwnableByCid('cid-1');
    const byNft = await repo.getOwnableByNft('eip155:base', '0xNFT', '1');
    const bySubject = await repo.getOwnableBySubjectId('0x11');

    expect(byCid?.cid).toBe('cid-1');
    expect(byNft?.id).toBe('own-1');
    expect(bySubject?.subjectId).toBe('0x11');
  });

  it('reads bridged cid list by previous owner', async () => {
    query.mockResolvedValueOnce({ rows: [{ cid: 'cid-1' }, { cid: 'cid-2' }] });

    const cids = await repo.listOwnableCidsByPrevOwner('0xOwner');

    expect(cids).toEqual(['cid-1', 'cid-2']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('prev_owner_address = LOWER($1)'), ['0xOwner']);
  });

  it('writes owner state with versioning increment path and reads by cid', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ owner: '0xowner', ownerAccount: 'eip155:84532:0xowner', version: 3, updatedAt: '2026-06-08T12:00:00.000Z' }] });

    await repo.setOwnerState('own-1', '0xOWNER', 'eip155:84532:0xowner', 'evt-1');
    const state = await repo.getOwnerStateByCid('cid-1');

    expect(state).toEqual({
      owner: '0xowner',
      ownerAccount: 'eip155:84532:0xowner',
      version: 3,
      updatedAt: '2026-06-08T12:00:00.000Z',
    });
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

  it('upserts replay-ready public events with transaction ordering metadata', async () => {
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
      subjectId: `0x${'2'.repeat(64)}`,
      sourceAddress: '0x00000000000000000000000000000000000000bb',
      eventType: 'transfer',
      dataHex: '0xdeadbeef',
      eventTimestamp: 321n,
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
      expect.arrayContaining([
        'mainnet',
        '8453',
        '0xA2',
        '26',
        '0xB2',
        '0xC2',
        1,
        5,
        `0x${'2'.repeat(64)}`,
        '0x00000000000000000000000000000000000000bb',
        'transfer',
        '0xdeadbeef',
        '321',
      ]),
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
      subjectId: `0x${'3'.repeat(64)}`,
      sourceAddress: '0x00000000000000000000000000000000000000bb',
      eventType: 'transfer',
      dataHex: '0x01',
      eventTimestamp: 1n,
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
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT id FROM ownable_records WHERE subject_id = LOWER($10)'),
      expect.any(Array),
    );
  });

  it('queries wallet export events ordered by block, transaction_index, and log_index', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          eventKind: 'public',
          subjectId: `0x${'4'.repeat(64)}`,
          sourceAddress: '0x00000000000000000000000000000000000000bb',
          eventType: 'transfer',
          dataHex: '0xdead',
          eventTimestamp: '123',
        },
      ],
    });

    const rows = await repo.listWalletEventsByCid('cid-abc');

    expect(rows).toEqual([
      expect.objectContaining({
        id: '1',
        eventKind: 'public',
        subjectId: `0x${'4'.repeat(64)}`,
        sourceAddress: '0x00000000000000000000000000000000000000bb',
        eventType: 'transfer',
        dataHex: '0xdead',
        eventTimestamp: '123',
      }),
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY "blockNumber"::numeric ASC, "transactionIndex" ASC, "logIndex" ASC'), ['cid-abc']);
  });

  it('resolves public events by ownable_records subject linkage when indexed before upload', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await repo.upsertIndexedPublicEvent({
      slotName: 'testnet',
      chainId: '84532',
      anchorContractAddress: '0xA2',
      blockNumber: 26n,
      blockHash: '0xB2',
      transactionHash: '0xC2',
      transactionIndex: 1,
      logIndex: 5,
      eventName: 'PublicEvent',
      subjectId: `0x${'5'.repeat(64)}`,
      sourceAddress: '0x00000000000000000000000000000000000000bb',
      eventType: 'transfer',
      dataHex: '0xdeadbeef',
      eventTimestamp: 321n,
      payloadJson: { key: 'value' },
    });

    query.mockResolvedValueOnce({ rows: [{ id: 'own-1', cid: 'cid-abc', prevOwnerAddress: '0xabc', subjectId: `0x${'5'.repeat(64)}` }] });
    await repo.upsertOwnableRecord({
      cid: 'cid-abc',
      prevOwnerAddress: '0xABC',
      subjectId: `0x${'5'.repeat(64)}`,
    });

    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'pub-1',
          eventKind: 'public',
          subjectId: `0x${'5'.repeat(64)}`,
          sourceAddress: '0x00000000000000000000000000000000000000bb',
          eventType: 'transfer',
          dataHex: '0xdeadbeef',
          eventTimestamp: '321',
        },
      ],
    });
    const rows = await repo.listWalletEventsByCid('cid-abc');

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'pub-1',
        eventKind: 'public',
        subjectId: `0x${'5'.repeat(64)}`,
      }),
    ]);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('OR subject_id IN ('),
      ['cid-abc'],
    );
  });

  it('queries available ownables by persisted current owner account with stable ordering', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          ownableId: '00000000-0000-0000-0000-000000000101',
          cid: 'cid-1',
          ownerAccount: 'eip155:84532:0xowner',
          subjectId: '0x11',
          ownerStateVersion: 3,
          availableAt: '2026-06-06T10:01:00.000Z',
          issuerAddress: '0xissuer',
          nftNetwork: 'eip155:base',
          nftContractAddress: '0xnft',
          nftTokenId: '1',
        },
      ],
    });

    const rows = await repo.listAvailableOwnablesByOwnerAccount('eip155:84532:0xowner');

    expect(rows).toEqual([
      expect.objectContaining({
        ownableId: '00000000-0000-0000-0000-000000000101',
        subjectId: '0x11',
        ownerStateVersion: 3,
        availableAt: '2026-06-06T10:01:00.000Z',
      }),
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE os.current_owner_account = $1'),
      ['eip155:84532:0xowner'],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY os.updated_at DESC, os.ownable_id ASC, os.owner_state_version ASC'),
      ['eip155:84532:0xowner'],
    );
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
  it('reads and writes account-targeted notify delivery-state with dedupe key', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'del-1',
          ownableId: 'own-1',
          ownerAddress: '0xowner',
          ownerAccount: 'eip155:84532:0xowner',
          ownerStateVersion: 2,
          triggerKind: 'upload',
          status: 'delivered',
          notificationType: 'type-id',
          notificationId: 'notify-1',
          transportId: 'transport-1',
          attemptCount: 1,
          lastAttemptAt: '2026-06-06T00:00:00.000Z',
          deliveredAt: '2026-06-06T00:00:01.000Z',
          errorCode: null,
          message: null,
        },
      ],
    });
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'del-1',
          ownableId: 'own-1',
          ownerAddress: '0xowner',
          ownerAccount: 'eip155:84532:0xowner',
          ownerStateVersion: 2,
          triggerKind: 'upload',
          status: 'delivered',
          notificationType: 'type-id',
          notificationId: 'notify-1',
          transportId: 'transport-1',
          attemptCount: 1,
          lastAttemptAt: '2026-06-06T00:00:00.000Z',
          deliveredAt: '2026-06-06T00:00:01.000Z',
          errorCode: null,
          message: null,
        },
      ],
    });

    const written = await repo.upsertNotifyDeliveryState({
      ownableId: 'own-1',
      ownerAddress: '0xOwner',
      ownerAccount: 'eip155:84532:0xowner',
      ownerStateVersion: 2,
      triggerKind: 'upload',
      status: 'delivered',
      notificationType: 'type-id',
      notificationId: 'notify-1',
      transportId: 'transport-1',
      attemptCount: 1,
      errorCode: null,
    });
    const read = await repo.getNotifyDeliveryStateByDedupKey({
      ownableId: 'own-1',
      ownerAccount: 'eip155:84532:0xowner',
      ownerStateVersion: 2,
      triggerKind: 'upload',
    });

    expect(written.id).toBe('del-1');
    expect(read?.status).toBe('delivered');
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('ON CONFLICT (ownable_id, owner_account, owner_state_version, trigger_kind) DO UPDATE SET'),
      ['own-1', '0xOwner', 'eip155:84532:0xowner', 2, 'upload', 'delivered', 'type-id', 'notify-1', 'transport-1', 1, null, null],
    );
  });

  it('maps failed_configuration notify insert values to last_error and non-delivered timestamps correctly', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'del-2',
          ownableId: 'own-2',
          ownerAddress: '0xowner',
          ownerAccount: 'eip155:84532:0xowner',
          ownerStateVersion: 3,
          triggerKind: 'upload',
          status: 'failed_configuration',
          notificationType: null,
          notificationId: null,
          transportId: null,
          attemptCount: 1,
          lastAttemptAt: '2026-06-06T00:00:00.000Z',
          deliveredAt: null,
          errorCode: 'missing_reown_config',
          message: 'notify disabled',
        },
      ],
    });

    await repo.upsertNotifyDeliveryState({
      ownableId: 'own-2',
      ownerAddress: '0xOwner',
      ownerAccount: 'eip155:84532:0xowner',
      ownerStateVersion: 3,
      triggerKind: 'upload',
      status: 'failed_configuration',
      attemptCount: 1,
      errorCode: 'missing_reown_config',
      lastError: 'notify disabled',
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(") VALUES ($1, LOWER($2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), CASE WHEN $6 = 'delivered' THEN NOW() ELSE NULL END)"),
      [
        'own-2',
        '0xOwner',
        'eip155:84532:0xowner',
        3,
        'upload',
        'failed_configuration',
        null,
        null,
        null,
        1,
        'missing_reown_config',
        'notify disabled',
      ],
    );
  });

  it('reads latest notify delivery-state by cid and owner account', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          cid: 'cid-1',
          ownableId: 'own-1',
          ownerAddress: '0xowner',
          ownerAccount: 'eip155:84532:0xowner',
          ownerStateVersion: 3,
          triggerKind: 'download_replay',
          status: 'not_subscribed',
          notificationType: 'type-id',
          notificationId: 'notify-2',
          transportId: null,
          attemptCount: 2,
          lastAttemptAt: '2026-06-06T00:00:00.000Z',
          deliveredAt: null,
          errorCode: 'reown_not_subscribed',
          message: 'Account is not subscribed to the configured notification type.',
        },
      ],
    });

    const row = await repo.getNotifyDeliveryStateByOwnableAndOwner('cid-1', 'eip155:84532:0xowner');

    expect(row?.cid).toBe('cid-1');
    expect(row?.status).toBe('not_subscribed');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM notify_delivery_state s'), ['cid-1', 'eip155:84532:0xowner']);
  });
});
