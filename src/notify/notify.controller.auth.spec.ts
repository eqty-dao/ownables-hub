import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { SIWEGuard } from '../common/siwe/siwe.guard.js';
import { NotifyController } from './notify.controller.js';
import { NotifyService } from './notify.service.js';

@Injectable()
class TestSignerMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const address = authHeader.slice(7);
      req['user'] = { address };
      req['signer'] = { address };
    }
    next();
  }
}

describe('NotifyController auth path', () => {
  const notifyService = {
    register: jest.fn().mockResolvedValue({ status: 'created', catchUpAttempted: 0 }),
  };

  it('rejects unauthenticated registration through SIWEGuard', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotifyController],
      providers: [
        SIWEGuard,
        TestSignerMiddleware,
        { provide: NotifyService, useValue: notifyService },
      ],
    }).compile();

    const middleware = moduleRef.get(TestSignerMiddleware);
    const guard = moduleRef.get(SIWEGuard);

    const req = { headers: {} } as Request;
    const next = jest.fn();
    middleware.use(req, {} as Response, next);
    expect(next).toHaveBeenCalled();

    expect(() =>
      guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => req,
        }),
      } as any),
    ).toThrow('User not authenticated via SIWE');

    await moduleRef.close();
  });

  it('passes signer identity from middleware into controller registration', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotifyController],
      providers: [
        SIWEGuard,
        TestSignerMiddleware,
        { provide: NotifyService, useValue: notifyService },
      ],
    }).compile();

    const middleware = moduleRef.get(TestSignerMiddleware);
    const guard = moduleRef.get(SIWEGuard);
    const controller = moduleRef.get(NotifyController);
    notifyService.register.mockClear();

    const req = { headers: { authorization: 'Bearer 0xAbC' } } as Request;
    middleware.use(req, {} as Response, () => undefined);

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

    await moduleRef.close();
  });
});
