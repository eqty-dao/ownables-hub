import { INestApplication, StreamableFile } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import JSZip from 'jszip';
import request from 'supertest';
import { OwnableController } from './ownable.controller.js';
import { UserError } from '../interfaces/error.js';
import { OwnableService } from './ownable.service.js';

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
  const binaryParser = (res: any, callback: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
    res.on('error', (err: Error) => callback(err, Buffer.alloc(0)));
  };

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

  it('maps unsupported runtime uploads to 400 client rejection', async () => {
    const ownableService = {
      uploadOwnable: jest
        .fn()
        .mockRejectedValue(
          new UserError(
            "Invalid package: unsupported Ownable runtime in 'ownable_bg.wasm'. Expected raw-ABI exports with no wasm imports; found unsupported imports from module(s): wbg",
          ),
        ),
    } as any;
    const controller = new OwnableController(ownableService);

    const req: any = { file: { buffer: Buffer.from('zip') } };
    const res = buildRes();

    await controller.uploadOwnable(req, res, undefined);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      "Invalid package: unsupported Ownable runtime in 'ownable_bg.wasm'. Expected raw-ABI exports with no wasm imports; found unsupported imports from module(s): wbg",
    );
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

  it('streams a non-empty zip body for GET /ownables/:cid/download over HTTP', async () => {
    const zip = new JSZip();
    zip.file('chain.json', JSON.stringify({ cid: 'cid-1' }));
    const zipBuffer = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
    const ownableService = {
      downloadOwnable: jest.fn().mockResolvedValue(new StreamableFile(zipBuffer)),
    } as any;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [OwnableController],
      providers: [{ provide: OwnableService, useValue: ownableService }],
    }).compile();

    let app: INestApplication | undefined;

    try {
      app = moduleFixture.createNestApplication();
      await app.init();

      const response = await request(app.getHttpServer())
        .get('/ownables/cid-1/download')
        .buffer(true)
        .parse(binaryParser)
        .expect(200)
        .expect('Content-Type', /application\/zip/);

      expect(ownableService.downloadOwnable).toHaveBeenCalledWith('cid-1');
      expect(response.body).toBeInstanceOf(Buffer);
      expect(response.body.length).toBeGreaterThan(0);

      const archive = await new JSZip().loadAsync(response.body);
      expect(archive.file('chain.json')).toBeTruthy();
      expect(archive.file('eventChain.json')).toBeNull();
    } finally {
      await app?.close();
    }
  });
});
