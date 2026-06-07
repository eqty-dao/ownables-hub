import { OwnableController } from './ownable.controller.js';
import { UserError } from '../interfaces/error.js';

jest.mock('eqty-core', () => require('../test-mocks/eqty-core.ts'));
jest.mock('@ownables/core', () => ({
  calculateOwnablePackageCid: jest.fn(),
  evaluateReplayFreshness: jest.fn(),
  OwnableService: class {},
  EventChainService: class {},
}));
jest.mock('@ownables/platform-node', () => ({
  NodePackageAssetIO: class {},
  NodeSandboxOwnableRPC: class {},
}));

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

  it('maps malformed upload archives to 400 client rejection', async () => {
    const ownableService = {
      uploadOwnable: jest
        .fn()
        .mockRejectedValue(new UserError("Invalid package: 'chain.json' and 'eventChain.json' differ")),
    } as any;
    const controller = new OwnableController(ownableService);

    const req: any = { file: { buffer: Buffer.from('zip') } };
    const res = buildRes();

    await controller.uploadOwnable(req, res, undefined);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith("Invalid package: 'chain.json' and 'eventChain.json' differ");
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

  it('rejects wrong signer for proof with non-200 response', async () => {
    const ownableService = {
      getUnlockProof: jest.fn().mockRejectedValue(new UserError('Signer 0x1 is not current NFT owner 0x2')),
    } as any;
    const controller = new OwnableController(ownableService);
    const res = buildRes();

    await controller.getUnlockProof('cid-1', { address: '0x1' }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalled();
  });

  it('keeps bridge and claim as thin aliases', async () => {
    const ownableService = {
      uploadOwnable: jest.fn().mockResolvedValue({ cid: 'cid-1' }),
      downloadOwnable: jest.fn().mockResolvedValue('stream'),
    } as any;
    const controller = new OwnableController(ownableService);

    const uploadReq: any = { file: { buffer: Buffer.from('zip') } };
    const uploadRes = buildRes();
    await controller.bridgeOwnable(uploadReq, uploadRes, undefined);
    expect(ownableService.uploadOwnable).toHaveBeenCalledWith(uploadReq.file.buffer, undefined, true);

    const claimRes = buildRes();
    await controller.claim('cid-1', claimRes);
    expect(ownableService.downloadOwnable).toHaveBeenCalledWith('cid-1');
  });
});
