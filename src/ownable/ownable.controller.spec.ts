import { INestApplication, StreamableFile } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import JSZip from 'jszip';
import request from 'supertest';
import { AppModule } from '../app.module.js';
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

  it('exports verification endpoint with ignored public event metadata', async () => {
    const verification = {
      ownableId: 'ownable-1',
      packageCid: 'cid-1',
      verified: true,
      owner: '0xowner',
      ownerAccount: 'eip155:84532:0xowner',
      freshness: { stale: false, missingReplayKeys: [], latestReplayKey: '0xa:1' },
      anchorVerification: { verified: true, anchors: { '0x1': '0xaaa' }, map: { '0x1': '0x2' }, details: {} },
      ignoredPublicEvents: [{ replayKey: '0xb:2', transactionHash: '0xb', logIndex: 2, reason: 'register_failed' }],
    };
    const ownableService = {
      getOwnableVerification: jest.fn().mockResolvedValue(verification),
    } as any;
    const controller = new OwnableController(ownableService);
    const res = buildRes();

    await controller.verification({ params: { id: 'ownable-1' } } as any, res);

    expect(ownableService.getOwnableVerification).toHaveBeenCalledWith('ownable-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(verification);
  });

  it('maps disabled recipient discovery to 404', async () => {
    const ownableService = {
      getAvailableOwnables: jest.fn().mockRejectedValue(new UserError('RECIPIENT_DISCOVERY_DISABLED')),
    } as any;
    const controller = new OwnableController(ownableService);
    const res = buildRes();

    await controller.available('eip155:84532:0xabc', res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('maps stale download to explicit stale client contract', async () => {
    const ownableService = {
      downloadOwnable: jest.fn().mockRejectedValue(new UserError('STALE_OWNABLE missingReplayKeys=0xaaa:1')),
    } as any;
    const controller = new OwnableController(ownableService);
    const res = buildRes();

    await controller.download({ params: { id: 'ownable-1' } } as any, res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('rejects wrong signer for proof with non-200 response', async () => {
    const ownableService = {
      getUnlockProof: jest.fn().mockRejectedValue(new UserError('Signer 0x1 is not current NFT owner 0x2')),
    } as any;
    const controller = new OwnableController(ownableService);
    const res = buildRes();

    await controller.getUnlockProof({ params: { id: 'ownable-1' } } as any, { address: '0x1' }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalled();
  });

  it('keeps bridge as a thin alias', async () => {
    const ownableService = {
      uploadOwnable: jest.fn().mockResolvedValue({ cid: 'cid-1' }),
    } as any;
    const controller = new OwnableController(ownableService);

    const uploadReq: any = { file: { buffer: Buffer.from('zip') } };
    const uploadRes = buildRes();
    await controller.bridgeOwnable(uploadReq, uploadRes, undefined);
    expect(ownableService.uploadOwnable).toHaveBeenCalledWith(uploadReq.file.buffer, undefined, true);
  });

  it('streams a non-empty zip body for GET /ownables/:id/bundle over HTTP', async () => {
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
        .get('/ownables/ownable-1/bundle')
        .buffer(true)
        .parse(binaryParser)
        .expect(200)
        .expect('Content-Type', /application\/zip/);

      expect(ownableService.downloadOwnable).toHaveBeenCalledWith('ownable-1');
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

describe('OwnableController recipient discovery route behavior', () => {
  const ownableService = {
    getAvailableOwnables: jest.fn(),
  };

  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://planner:planner@127.0.0.1:5432/ownables_hub_test';
    process.env.SIGNER_MNEMONIC = process.env.SIGNER_MNEMONIC || 'test test test test test test test test test test test junk';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OwnableService)
      .useValue(ownableService)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    ownableService.getAvailableOwnables.mockReset();
  });

  it('serves recipient discovery without SIWE auth on the canonical route', async () => {
    ownableService.getAvailableOwnables.mockResolvedValue({
      owner: 'eip155:84532:0xabc',
      entries: [
        {
          id: '0x11',
          title: 'Potion',
          description: 'Recovered from the stored package.',
          issuer: '0xissuer',
          availableAt: '2026-06-07T10:02:00.000Z',
          package: {
            cid: 'cid-1',
            thumbnailUrl: 'https://example.com/potion.png',
          },
        },
      ],
    });

    await request(app.getHttpServer())
      .get('/ownables/available')
      .query({ owner: 'eip155:84532:0xabc' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          owner: 'eip155:84532:0xabc',
          entries: [
            {
              id: '0x11',
              title: 'Potion',
              description: 'Recovered from the stored package.',
              issuer: '0xissuer',
              availableAt: '2026-06-07T10:02:00.000Z',
              package: {
                cid: 'cid-1',
                thumbnailUrl: 'https://example.com/potion.png',
              },
            },
          ],
        });
        expect(body).not.toHaveProperty('ownerAccount');
        expect(body.entries[0]).not.toHaveProperty('import');
        expect(body.entries[0]).not.toHaveProperty('availabilityKey');
        expect(body.entries[0]).not.toHaveProperty('subjectId');
        expect(body.entries[0]).not.toHaveProperty('ownerStateVersion');
      });

    expect(ownableService.getAvailableOwnables).toHaveBeenCalledWith('eip155:84532:0xabc');
  });

  it('returns 404 when recipient discovery is disabled', async () => {
    ownableService.getAvailableOwnables.mockRejectedValue(new UserError('RECIPIENT_DISCOVERY_DISABLED'));

    await request(app.getHttpServer()).get('/ownables/available').query({ owner: 'eip155:84532:0xabc' }).expect(404);
  });

  it('returns 400 when owner is missing or malformed', async () => {
    ownableService.getAvailableOwnables.mockRejectedValueOnce(new UserError('owner is required'));
    await request(app.getHttpServer()).get('/ownables/available').expect(400);

    ownableService.getAvailableOwnables.mockRejectedValueOnce(new UserError('owner must be a valid CAIP-10 account'));
    await request(app.getHttpServer()).get('/ownables/available').query({ owner: 'not-caip10' }).expect(400);
  });
});
