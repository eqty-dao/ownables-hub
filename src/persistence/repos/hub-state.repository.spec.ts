import { HubStateRepository } from './hub-state.repository.js';

describe('HubStateRepository', () => {
  const query = jest.fn();
  const db = { query };
  let repo: HubStateRepository;

  beforeEach(() => {
    query.mockReset();
    repo = new HubStateRepository(db as any);
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
