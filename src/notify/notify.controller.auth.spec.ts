import { INestApplication } from '@nestjs/common';
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
});
