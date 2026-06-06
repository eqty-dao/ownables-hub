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

  it('returns the local discovery response shape', async () => {
    const notifyService = {
      getLocalDiscoveryEntries: jest.fn().mockResolvedValue({
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
      }),
    };
    const controller = new NotifyController(notifyService as any);

    const result = await controller.getLocalDiscovery('eip155:84532:0xabc');

    expect(result).toEqual({
      ownerAccount: 'eip155:84532:0xabc',
      entries: [expect.objectContaining({ id: 'local:ownables_1', source: 'hub-local-dev' })],
    });
  });
});
