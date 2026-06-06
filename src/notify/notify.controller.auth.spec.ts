import { BadRequestException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { NotifyService } from './notify.service.js';

jest.mock('@ownables/core', () => ({
  calculateOwnablePackageCid: jest.fn(),
  evaluateReplayFreshness: jest.fn(),
  EventChainService: jest.fn(),
  OwnableService: jest.fn(),
}));

jest.mock('@ownables/platform-node', () => ({
  NodePackageAssetIO: jest.fn(),
  NodeSandboxOwnableRPC: jest.fn(),
}));

describe('NotifyController route behavior', () => {
  const notifyService = {
    getDeliveryStatus: jest.fn(),
    getLocalDiscoveryEntries: jest.fn(),
  };

  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://planner:planner@127.0.0.1:5432/ownables_hub_test';
    process.env.ACCOUNT_MNEMONIC = process.env.ACCOUNT_MNEMONIC || 'test test test test test test test test test test test junk';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(NotifyService)
      .useValue(notifyService)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    notifyService.getDeliveryStatus.mockReset();
    notifyService.getLocalDiscoveryEntries.mockReset();
  });

  it('removes the old registration route', async () => {
    await request(app.getHttpServer()).post('/notify/registrations').send({ ownerAddress: '0xabc', topic: 'topic-a' }).expect(404);
  });

  it('serves delivery status without SIWE auth on the real route', async () => {
    notifyService.getDeliveryStatus.mockResolvedValue({
      cid: 'cid-1',
      ownerAccount: 'eip155:84532:0xabc',
      ownerStateVersion: 2,
      triggerKind: 'upload',
      status: 'delivered',
      notificationId: 'notify-1',
      transportId: 'transport-1',
      lastAttemptAt: '2026-06-06T00:00:00.000Z',
      deliveredAt: '2026-06-06T00:00:01.000Z',
      errorCode: null,
      message: null,
    });

    await request(app.getHttpServer())
      .get('/notify/delivery-status')
      .query({ cid: 'cid-1', owner: 'eip155:84532:0xabc' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          cid: 'cid-1',
          owner: 'eip155:84532:0xabc',
          ownerStateVersion: 2,
          triggerKind: 'upload',
          status: 'delivered',
          notificationId: 'notify-1',
          transportId: 'transport-1',
          lastAttemptAt: '2026-06-06T00:00:00.000Z',
          deliveredAt: '2026-06-06T00:00:01.000Z',
          errorCode: null,
          message: null,
        });
      });

    expect(notifyService.getDeliveryStatus).toHaveBeenCalledWith('cid-1', 'eip155:84532:0xabc');
  });

  it('serves local discovery without SIWE auth on the real route', async () => {
    notifyService.getLocalDiscoveryEntries.mockResolvedValue({
      ownerAccount: 'eip155:84532:0xabc',
      entries: [
        {
          id: 'local:ownables_1',
          source: 'hub-local-dev',
          deliveryStatus: 'failed_configuration',
          warningCode: 'missing_reown_config',
          warningMessage: 'notify disabled',
          triggerKind: 'upload',
          ownerStateVersion: 2,
          notification: {
            type: 'ownables.v1.available',
            eventId: 'ownables_1',
            createdAt: '2026-06-06T00:00:00.000Z',
            ownableId: 'own-1',
            cid: 'cid-1',
            scope: 'direct',
            issuerAddress: '0xissuer',
            ownerAccount: 'eip155:84532:0xabc',
            ownerAddress: '0xabc',
            url: 'http://127.0.0.1:3000/ownables/cid-1/download',
          },
          title: 'New Ownable available',
          body: 'Issued by 0xissu...suer. Open to review and download.',
        },
      ],
    });

    await request(app.getHttpServer())
      .get('/notify/local/discovery')
      .query({ owner: 'eip155:84532:0xabc' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          ownerAccount: 'eip155:84532:0xabc',
          entries: [expect.objectContaining({ id: 'local:ownables_1', source: 'hub-local-dev' })],
        });
      });

    expect(notifyService.getLocalDiscoveryEntries).toHaveBeenCalledWith('eip155:84532:0xabc');
  });

  it('returns 404 on the real route when local discovery is disabled', async () => {
    notifyService.getLocalDiscoveryEntries.mockRejectedValue(new NotFoundException());

    await request(app.getHttpServer()).get('/notify/local/discovery').query({ owner: 'eip155:84532:0xabc' }).expect(404);
  });

  it('returns 400 on the real route for missing or malformed local discovery owner input', async () => {
    notifyService.getLocalDiscoveryEntries.mockRejectedValueOnce(new BadRequestException('owner is required'));

    await request(app.getHttpServer()).get('/notify/local/discovery').expect(400);

    notifyService.getLocalDiscoveryEntries.mockRejectedValueOnce(new BadRequestException('owner must be a valid CAIP-10 account'));

    await request(app.getHttpServer()).get('/notify/local/discovery').query({ owner: 'not-caip10' }).expect(400);
  });
});
