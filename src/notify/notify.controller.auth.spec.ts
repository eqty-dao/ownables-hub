import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { SIWEService } from '../common/siwe/siwe.service.js';
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

describe('NotifyController auth path', () => {
  const notifyService = {
    register: jest.fn().mockResolvedValue({ status: 'created', catchUpAttempted: 0 }),
  };
  const siweService = {
    verifySIWEMessage: jest.fn().mockResolvedValue({ isValid: true, address: '0xAbC' }),
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
      .overrideProvider(SIWEService)
      .useValue(siweService)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    notifyService.register.mockClear();
    siweService.verifySIWEMessage.mockClear();
  });

  function buildBearerToken(messageAddress = '0xAbC'): string {
    const payload = {
      message: {
        domain: 'localhost',
        address: messageAddress,
        statement: '',
        uri: 'http://localhost',
        version: '1',
        chainId: 1,
        nonce: 'nonce',
        issuedAt: new Date().toISOString(),
      },
      signature: '0xdeadbeef',
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  it('rejects unauthenticated registration on the real route', async () => {
    await request(app.getHttpServer())
      .post('/notify/registrations')
      .send({ ownerAddress: '0xabc', topic: 'topic-a' })
      .expect(401);

    expect(notifyService.register).not.toHaveBeenCalled();
    expect(siweService.verifySIWEMessage).not.toHaveBeenCalled();
  });

  it('uses SIWE signer identity for authenticated registration on the real route', async () => {
    await request(app.getHttpServer())
      .post('/notify/registrations')
      .set('Authorization', `Bearer ${buildBearerToken('0xAbC')}`)
      .send({ ownerAddress: '0xabc', topic: 'topic-a' })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toEqual({ status: 'created', catchUpAttempted: 0 });
      });

    expect(siweService.verifySIWEMessage).toHaveBeenCalledTimes(1);
    expect(notifyService.register).toHaveBeenCalledWith({
      ownerAddress: '0xabc',
      topic: 'topic-a',
      previousTopic: undefined,
      ownerAccount: undefined,
      signerAddress: '0xAbC',
    });
  });
});
