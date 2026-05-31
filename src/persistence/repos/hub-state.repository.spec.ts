import { HubStateRepository } from './hub-state.repository.js';

describe('HubStateRepository', () => {
  const query = jest.fn();
  const db = { query };
  let repo: HubStateRepository;

  beforeEach(() => {
    query.mockReset();
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
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO ownable_records'),
      expect.arrayContaining(['cid-1', '0xABC', 'eip155:base', '0xNFT', '1']),
    );
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('FROM ownable_records WHERE cid = $1'), ['cid-1']);
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('WHERE nft_network = $1 AND nft_contract_address = $2 AND nft_token_id = $3'),
      ['eip155:base', '0xNFT', '1'],
    );
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
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('owner_state_version = ownable_owner_state.owner_state_version + 1'),
      ['own-1', '0xOWNER', 'evt-1'],
    );
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('FROM ownable_owner_state s'), ['cid-1']);
  });

  it('upserts indexer cursor state', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await repo.upsertIndexerCursor({
      slotName: 'testnet',
      cursorName: 'anchor',
      chainId: '84532',
      anchorContractAddress: '0xAnchor',
      nextFromBlock: 10n,
      lastScannedBlock: 9n,
      lastScannedTxHash: '0xTx',
      lastScannedLogIndex: 7,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO indexer_cursors'),
      ['testnet', 'anchor', '84532', '0xAnchor', '10', '9', '0xTx', 7],
    );
  });

  it('persists cursor resume block updates across successive upserts', async () => {
    query.mockResolvedValue({ rows: [] });

    await repo.upsertIndexerCursor({
      slotName: 'mainnet',
      cursorName: 'anchor',
      chainId: '8453',
      anchorContractAddress: '0xAnchor',
      nextFromBlock: 120n,
      lastScannedBlock: 119n,
      lastScannedTxHash: '0xold',
      lastScannedLogIndex: 2,
    });

    await repo.upsertIndexerCursor({
      slotName: 'mainnet',
      cursorName: 'anchor',
      chainId: '8453',
      anchorContractAddress: '0xAnchor',
      nextFromBlock: 121n,
      lastScannedBlock: 120n,
      lastScannedTxHash: '0xnew',
      lastScannedLogIndex: 0,
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('ON CONFLICT (slot_name, cursor_name) DO UPDATE SET'),
      ['mainnet', 'anchor', '8453', '0xAnchor', '120', '119', '0xold', 2],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ON CONFLICT (slot_name, cursor_name) DO UPDATE SET'),
      ['mainnet', 'anchor', '8453', '0xAnchor', '121', '120', '0xnew', 0],
    );
  });

  it('upserts notify registration transitions', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await repo.upsertNotifyRegistration({
      ownerAddress: '0xOwner',
      ownerAccount: 'eip155:base:0xOwner',
      topic: 'wc-topic',
      status: 'stale',
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notify_registrations'),
      ['0xOwner', 'eip155:base:0xOwner', 'wc-topic', 'stale'],
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (owner_address, topic) DO UPDATE SET'),
      expect.any(Array));
  });

  it('upserts notify delivery state with dedupe conflict key', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await repo.upsertNotifyDeliveryState({
      registrationId: 'reg-1',
      ownableId: 'own-1',
      ownerStateVersion: 5,
      triggerKind: 'availability',
      status: 'delivered',
      attemptCount: 2,
      lastError: null,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notify_delivery_state'),
      ['reg-1', 'own-1', 5, 'availability', 'delivered', 2, null],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (registration_id, ownable_id, owner_state_version, trigger_kind) DO UPDATE SET'),
      expect.any(Array),
    );
  });

  it('upserts anchor events into indexed_anchor_events', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await repo.upsertIndexedAnchorEvent({
      slotName: 'testnet',
      chainId: '84532',
      anchorContractAddress: '0xA1',
      blockNumber: 25n,
      blockHash: '0xB1',
      transactionHash: '0xC1',
      logIndex: 4,
      eventName: 'AnchorEvent',
      cid: 'cid-1',
      ownableId: 'oid-1',
      ownerAddress: '0xD1',
      payloadJson: { key: 'value' },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO indexed_anchor_events'),
      expect.arrayContaining(['testnet', '84532', '0xA1', '25', '0xB1', '0xC1', 4, 'AnchorEvent']),
    );
  });

  it('upserts public events into indexed_public_events', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await repo.upsertIndexedPublicEvent({
      slotName: 'mainnet',
      chainId: '8453',
      anchorContractAddress: '0xA2',
      blockNumber: 26n,
      blockHash: '0xB2',
      transactionHash: '0xC2',
      logIndex: 5,
      eventName: 'PublicEvent',
      payloadJson: { key: 'value' },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO indexed_public_events'),
      expect.arrayContaining(['mainnet', '8453', '0xA2', '26', '0xB2', '0xC2', 5, 'PublicEvent']),
    );
  });

  it('queries wallet export events through anchor/public union', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: '1', eventKind: 'anchor' }] });

    const rows = await repo.listWalletEventsByCid('cid-abc');

    expect(rows).toEqual([{ id: '1', eventKind: 'anchor' }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UNION ALL'), ['cid-abc']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM indexed_anchor_events'), ['cid-abc']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM indexed_public_events'), ['cid-abc']);
  });
});
