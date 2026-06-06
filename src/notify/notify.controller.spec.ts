import { NotFoundException } from '@nestjs/common';
import { NotifyController } from './notify.controller.js';

describe('NotifyController', () => {
  it('returns the public limited delivery status response shape', async () => {
    const notifyService = {
      getDeliveryStatus: jest.fn().mockResolvedValue({
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
      }),
    };
    const controller = new NotifyController(notifyService as any);

    const result = await controller.getDeliveryStatus('cid-1', 'eip155:84532:0xabc');

    expect(result).toEqual({
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

  it('returns 404 semantics for unknown cid/owner combinations', async () => {
    const notifyService = { getDeliveryStatus: jest.fn().mockResolvedValue(null) };
    const controller = new NotifyController(notifyService as any);

    await expect(controller.getDeliveryStatus('cid-1', 'eip155:84532:0xmissing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
