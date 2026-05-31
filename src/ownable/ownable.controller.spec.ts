import { OwnableController } from './ownable.controller.js';
import { UserError } from '../interfaces/error.js';

jest.mock('@ownables/core', () => ({
  calculateOwnablePackageCid: () => 'cid-mock',
  evaluateReplayFreshness: jest.fn(() => ({ stale: false, missingReplayKeys: [] })),
  publicEventReplayKey: ({ transactionHash, logIndex }: { transactionHash: string; logIndex: number }) =>
    `${transactionHash}:${logIndex}`,
}));
jest.mock('eqty-core', () => require('../test-mocks/eqty-core.ts'));

describe('OwnableController', () => {
  const buildRes = () => {
    const res: any = {};
    res.status = jest.fn(() => res);
    res.send = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };

  it('keeps upload endpoint public and accepts valid uploads without signer', async () => {
    const ownableService = {
      uploadOwnable: jest.fn().mockResolvedValue({ cid: 'cid-1' }),
    } as any;
    const controller = new OwnableController(ownableService);

    const req: any = { file: { buffer: Buffer.from('zip') } };
    const res = buildRes();

    await controller.uploadOwnable(req, res, undefined);

    expect(ownableService.uploadOwnable).toHaveBeenCalledWith(req.file.buffer, undefined, true);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('exports events endpoint deterministically as service ordered payload', async () => {
    const ordered = [
      { transactionHash: '0xa', transactionIndex: 0, logIndex: 1 },
      { transactionHash: '0xb', transactionIndex: 1, logIndex: 0 },
    ];
    const ownableService = {
      getOwnableEvents: jest.fn().mockResolvedValue(ordered),
    } as any;
    const controller = new OwnableController(ownableService);
    const res = buildRes();

    await controller.events({ params: { cid: 'cid-1' } } as any, res);

    expect(ownableService.getOwnableEvents).toHaveBeenCalledWith('cid-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ cid: 'cid-1', events: ordered });
  });

  it('maps stale download to explicit stale client contract', async () => {
    const ownableService = {
      downloadOwnable: jest.fn().mockRejectedValue(new UserError('STALE_OWNABLE missingReplayKeys=0xaaa:1')),
    } as any;
    const controller = new OwnableController(ownableService);
    const res = buildRes();

    await controller.download({ params: { cid: 'cid-1' } } as any, res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('proof remains signer-sensitive via service behavior', async () => {
    const ownableService = {
      getUnlockProof: jest.fn().mockRejectedValue(new Error('Missing SIWE signer')),
    } as any;
    const controller = new OwnableController(ownableService);

    const result = await controller.getUnlockProof('cid-1', undefined);

    expect(ownableService.getUnlockProof).toHaveBeenCalledWith('cid-1', undefined);
    expect(result).toEqual({ error: 'Error: Missing SIWE signer' });
  });
});
