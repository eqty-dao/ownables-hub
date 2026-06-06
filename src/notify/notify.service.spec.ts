import { NotifyService } from './notify.service.js';
import { ReownTransportError } from './reown-notify.transport.js';

describe('NotifyService', () => {
  const buildRepo = () => ({
    getNotifyDeliveryStateByDedupKey: jest.fn(),
    getNotifyDeliveryStateByOwnableAndOwner: jest.fn(),
    upsertNotifyDeliveryState: jest.fn(),
  });

  const buildConfig = (overrides: Partial<any> = {}) => ({
    getRuntimeNetworkProfile: jest.fn().mockReturnValue('testnet'),
    getAppConfig: jest.fn().mockReturnValue({ publicBaseUrl: 'https://hub.example.com' }),
    getReownConfig: jest.fn().mockReturnValue({
      projectId: 'proj',
      notifyApiSecret: 'secret',
      notificationTypeId: 'type-id',
      appDomain: 'hub.example.com',
    }),
    getReownConfigIssue: jest.fn().mockReturnValue(null),
    ...overrides,
  });

  const buildTransport = () => ({
    getSubscriber: jest.fn().mockResolvedValue({ subscribed: true, notificationTypes: ['type-id'] }),
    publish: jest.fn().mockResolvedValue({ transportId: 'transport-1' }),
  });

  const notifyInput = () => ({
    ownerAddress: '0x6465aa5c80764b174606094decaa4ee9560a2e43',
    ownerNetwork: 'eip155:base',
    ownableId: 'own-1',
    cid: 'cid-1',
    ownerStateVersion: 2,
    latestAppliedPublicEventId: 'evt-1',
    issuerAddress: '0xdef',
    nftNetwork: 'eip155:base',
    nftContractAddress: '0xnft',
    nftTokenId: '1',
    triggerKind: 'upload' as const,
  });

  it('dedupes by delivered delivery-state tuple', async () => {
    const repo = buildRepo();
    repo.getNotifyDeliveryStateByDedupKey.mockResolvedValue({ status: 'delivered', attemptCount: 1 });

    const service = new NotifyService(repo as any, buildConfig() as any, buildTransport() as any);
    const result = await service.notifyOwnableAvailability(notifyInput());

    expect(result).toEqual({
      status: 'delivered',
      ownerAccount: 'eip155:84532:0x6465aa5c80764b174606094decaa4ee9560a2e43',
    });
    expect(repo.upsertNotifyDeliveryState).not.toHaveBeenCalled();
  });

  it('persists failed configuration when owner account derivation fails', async () => {
    const repo = buildRepo();
    const service = new NotifyService(repo as any, buildConfig() as any, buildTransport() as any);

    const result = await service.notifyOwnableAvailability({ ...notifyInput(), ownerNetwork: 'eip155:unknown' });

    expect(result.status).toBe('failed_configuration');
    expect(result.warningCode).toBe('owner_account_derivation_failed');
    expect(repo.upsertNotifyDeliveryState).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed_configuration' }));
  });

  it('persists missing config as a warning without publishing', async () => {
    const repo = buildRepo();
    const transport = buildTransport();
    const service = new NotifyService(
      repo as any,
      buildConfig({
        getReownConfig: jest.fn().mockReturnValue(null),
        getReownConfigIssue: jest.fn().mockReturnValue({
          code: 'missing_reown_config',
          message: 'notify disabled',
        }),
      }) as any,
      transport as any,
    );

    const result = await service.notifyOwnableAvailability(notifyInput());

    expect(result).toEqual({
      status: 'failed_configuration',
      ownerAccount: 'eip155:84532:0x6465aa5c80764b174606094decaa4ee9560a2e43',
      warningCode: 'missing_reown_config',
      warningMessage: 'notify disabled',
    });
    expect(transport.getSubscriber).not.toHaveBeenCalled();
  });

  it('persists not_subscribed when subscriber preflight misses the configured type', async () => {
    const repo = buildRepo();
    const transport = buildTransport();
    transport.getSubscriber.mockResolvedValue({ subscribed: true, notificationTypes: ['other-type'] });
    const service = new NotifyService(repo as any, buildConfig() as any, transport as any);

    const result = await service.notifyOwnableAvailability(notifyInput());

    expect(result.status).toBe('not_subscribed');
    expect(repo.upsertNotifyDeliveryState).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not_subscribed', errorCode: 'reown_not_subscribed' }),
    );
    expect(transport.publish).not.toHaveBeenCalled();
  });

  it('publishes with deterministic notification ids and absolute download urls', async () => {
    const repo = buildRepo();
    const transport = buildTransport();
    const service = new NotifyService(repo as any, buildConfig() as any, transport as any);

    const first = await service.notifyOwnableAvailability(notifyInput());
    const second = await service.notifyOwnableAvailability(notifyInput());

    expect(first.status).toBe('delivered');
    expect(second.status).toBe('delivered');
    const [firstRequest, secondRequest] = transport.publish.mock.calls.map(([request]) => request);
    expect(firstRequest.url).toBe('https://hub.example.com/ownables/cid-1/download');
    expect(secondRequest.payload?.eventId).toBe(firstRequest.payload?.eventId);
  });

  it('classifies Reown auth failures as failed_configuration', async () => {
    const repo = buildRepo();
    const transport = buildTransport();
    transport.publish.mockRejectedValue(new ReownTransportError('reown_auth_failed', 401, 'bad secret'));
    const service = new NotifyService(repo as any, buildConfig() as any, transport as any);

    const result = await service.notifyOwnableAvailability(notifyInput());

    expect(result.status).toBe('failed_configuration');
    expect(repo.upsertNotifyDeliveryState).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed_configuration', errorCode: 'reown_auth_failed' }),
    );
  });

  it('classifies Reown rate limiting as failed_transient', async () => {
    const repo = buildRepo();
    const transport = buildTransport();
    transport.publish.mockRejectedValue(new ReownTransportError('reown_rate_limited', 429, 'slow down'));
    const service = new NotifyService(repo as any, buildConfig() as any, transport as any);

    const result = await service.notifyOwnableAvailability(notifyInput());

    expect(result.status).toBe('failed_transient');
    expect(repo.upsertNotifyDeliveryState).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed_transient', errorCode: 'reown_rate_limited' }),
    );
  });

  it('reads delivery status by cid and owner account', async () => {
    const repo = buildRepo();
    repo.getNotifyDeliveryStateByOwnableAndOwner.mockResolvedValue({ id: 'del-1', status: 'delivered' });
    const service = new NotifyService(repo as any, buildConfig() as any, buildTransport() as any);

    const result = await service.getDeliveryStatus('cid-1', 'eip155:84532:0xabc');

    expect(result).toEqual({ id: 'del-1', status: 'delivered' });
    expect(repo.getNotifyDeliveryStateByOwnableAndOwner).toHaveBeenCalledWith('cid-1', 'eip155:84532:0xabc');
  });
});
