import { BadRequestException } from '@nestjs/common';
import { NotifyService } from './notify.service.js';

describe('NotifyService', () => {
  const buildRepo = () => ({
    listActiveNotifyRegistrationsByOwner: jest.fn(),
    upsertNotifyRegistration: jest.fn(),
    markNotifyRegistrationReplaced: jest.fn(),
    listAvailableOwnablesByOwner: jest.fn(),
    getNotifyDeliveryState: jest.fn(),
    upsertNotifyDeliveryState: jest.fn(),
    markNotifyRegistrationStale: jest.fn(),
  });

  it('rejects signer/owner mismatch', async () => {
    const repo = buildRepo();
    const service = new NotifyService(repo as any);

    await expect(
      service.register({ ownerAddress: '0x1', signerAddress: '0x2', topic: 'topic-a' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates registration and performs catch-up publication', async () => {
    const repo = buildRepo();
    repo.listActiveNotifyRegistrationsByOwner.mockResolvedValue([]);
    repo.upsertNotifyRegistration.mockResolvedValue({ id: 'reg-1', ownerAddress: '0xabc', topic: 'topic-a' });
    repo.listAvailableOwnablesByOwner.mockResolvedValue([
      {
        ownableId: 'own-1',
        cid: 'cid-1',
        ownerAddress: '0xabc',
        ownerStateVersion: 4,
        latestAppliedPublicEventId: 'evt-1',
        prevOwnerAddress: '0xdef',
        nftNetwork: null,
        nftContractAddress: null,
        nftTokenId: null,
      },
    ]);
    repo.getNotifyDeliveryState.mockResolvedValue(null);

    const service = new NotifyService(repo as any);
    const result = await service.register({ ownerAddress: '0xabc', signerAddress: '0xabc', topic: 'topic-a' });

    expect(result).toEqual({ status: 'created', catchUpAttempted: 1 });
    expect(repo.upsertNotifyDeliveryState).toHaveBeenCalledWith(expect.objectContaining({ status: 'delivered' }));
  });

  it('replaces previous topic when requested', async () => {
    const repo = buildRepo();
    repo.listActiveNotifyRegistrationsByOwner.mockResolvedValue([{ topic: 'topic-a' }]);
    repo.upsertNotifyRegistration.mockResolvedValue({ id: 'reg-2', ownerAddress: '0xabc', topic: 'topic-b' });
    repo.listAvailableOwnablesByOwner.mockResolvedValue([]);

    const service = new NotifyService(repo as any);
    const result = await service.register({ ownerAddress: '0xabc', signerAddress: '0xabc', topic: 'topic-b', previousTopic: 'topic-a' });

    expect(result.status).toBe('replaced');
    expect(repo.markNotifyRegistrationReplaced).toHaveBeenCalledWith('0xabc', 'topic-a', 'reg-2');
  });

  it('dedupes by delivered delivery-state tuple', async () => {
    const repo = buildRepo();
    repo.listActiveNotifyRegistrationsByOwner.mockResolvedValue([{ id: 'reg-1', ownerAddress: '0xabc', topic: 'topic-a' }]);
    repo.getNotifyDeliveryState.mockResolvedValue({ status: 'delivered', attemptCount: 1 });

    const service = new NotifyService(repo as any);
    await service.notifyOwnableAvailability({
      ownerAddress: '0xabc',
      ownableId: 'own-1',
      cid: 'cid-1',
      ownerStateVersion: 2,
      latestAppliedPublicEventId: null,
      issuerAddress: '0xdef',
      triggerKind: 'upload',
    });

    expect(repo.upsertNotifyDeliveryState).not.toHaveBeenCalled();
  });
});
