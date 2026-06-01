import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { SIWEAuthMiddleware } from '../common/siwe/siwe-auth.middleware.js';
import { SIWEGuard } from '../common/siwe/siwe.guard.js';
import { SIWEService } from '../common/siwe/siwe.service.js';
import { SIWEModule } from '../common/siwe/siwe.module.js';
import { NotifyController } from './notify.controller.js';
import { NotifyModule } from './notify.module.js';
import { NotifyService } from './notify.service.js';

@Module({
  imports: [NotifyModule, SIWEModule],
})
class NotifyAuthRouteTestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SIWEAuthMiddleware).forRoutes(NotifyController);
  }
}

describe('NotifyController auth path', () => {
  const notifyService = {
    register: jest.fn().mockResolvedValue({ status: 'created', catchUpAttempted: 0 }),
  };
  const siweService = {
    verifySIWEMessage: jest.fn().mockResolvedValue({ isValid: true, address: '0xAbC' }),
  };

  let middleware: SIWEAuthMiddleware;
  let guard: SIWEGuard;
  let controller: NotifyController;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://planner:planner@127.0.0.1:5432/ownables_hub_test';
    process.env.ACCOUNT_MNEMONIC = process.env.ACCOUNT_MNEMONIC || 'test test test test test test test test test test test junk';

    const moduleRef = await Test.createTestingModule({
      imports: [NotifyAuthRouteTestModule],
    })
      .overrideProvider(NotifyService)
      .useValue(notifyService)
      .overrideProvider(SIWEService)
      .useValue(siweService)
      .compile();

    middleware = moduleRef.get(SIWEAuthMiddleware);
    guard = moduleRef.get(SIWEGuard);
    controller = moduleRef.get(NotifyController);
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

  it('wires SIWE middleware and notify route metadata for POST /notify/registrations', () => {
    const apply = jest.fn().mockReturnValue({ forRoutes: jest.fn() });
    new NotifyAuthRouteTestModule().configure({ apply } as unknown as MiddlewareConsumer);
    expect(apply).toHaveBeenCalledWith(SIWEAuthMiddleware);

    const controllerPath = Reflect.getMetadata(PATH_METADATA, NotifyController);
    const methodPath = Reflect.getMetadata(PATH_METADATA, NotifyController.prototype.register as object);
    const method = Reflect.getMetadata(METHOD_METADATA, NotifyController.prototype.register as object);
    expect(controllerPath).toBe('notify');
    expect(methodPath).toBe('registrations');
    expect(method).toBe(RequestMethod.POST);
  });

  it('rejects unauthenticated registration via SIWE middleware + guard path', async () => {
    const req = { headers: {} } as Request;
    const next = jest.fn();
    await middleware.use(req, {} as Response, next);
    expect(next).toHaveBeenCalled();

    expect(siweService.verifySIWEMessage).not.toHaveBeenCalled();
    expect(notifyService.register).not.toHaveBeenCalled();
    expect(() =>
      guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => req,
        }),
      } as any),
    ).toThrow('User not authenticated via SIWE');
  });

  it('uses SIWE signer identity for authenticated registration', async () => {
    const req = {
      headers: { authorization: `Bearer ${buildBearerToken('0xAbC')}` },
    } as Request;
    const next = jest.fn();
    await middleware.use(req, {} as Response, next);
    expect(next).toHaveBeenCalled();

    expect(siweService.verifySIWEMessage).toHaveBeenCalledTimes(1);
    expect(
      guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => req,
        }),
      } as any),
    ).toBe(true);

    await controller.register({ ownerAddress: '0xabc', topic: 'topic-a' }, req['signer']);
    expect(notifyService.register).toHaveBeenCalledWith({
      ownerAddress: '0xabc',
      topic: 'topic-a',
      previousTopic: undefined,
      ownerAccount: undefined,
      signerAddress: '0xAbC',
    });
  });
});
