import { OwnableTransportService } from './ownable-transport.service.js';

describe('OwnableTransportService', () => {
  const listen = jest.fn();
  const notify = jest.fn();

  beforeEach(() => {
    listen.mockReset();
    notify.mockReset();
  });

  it('emits locally, forwards cross-process notifications, and ignores same-origin echoes', async () => {
    let handleNotification!: (payload: string) => void;
    const stop = jest.fn().mockResolvedValue(undefined);
    listen.mockImplementation(async (_channel: string, onPayload: (payload: string) => void) => {
      handleNotification = onPayload;
      return stop;
    });

    const service = new OwnableTransportService({
      listen,
      notify,
    } as any);

    await service.onModuleInit();

    const received: any[] = [];
    const subscription = service.watchPublicEvents().subscribe((message) => received.push(message));
    const outbound = {
      subjectId: `0x${'1'.repeat(64)}`,
      publicEvent: {
        source: '0x00000000000000000000000000000000000000bb',
        eventType: 'transfer',
        data: '0x01',
        blockNumber: 11,
        transactionHash: '0xbbb',
        transactionIndex: 0,
        logIndex: 1,
        timestamp: 41,
      },
    };

    notify.mockResolvedValue(undefined);
    service.publishPublicEvent(outbound);

    expect(received).toEqual([outbound]);
    expect(notify).toHaveBeenCalledWith(
      'ownables_public_events',
      expect.stringContaining(`"subjectId":"${outbound.subjectId}"`),
    );

    const firstPayload = JSON.parse(notify.mock.calls[0][1] as string) as { origin: string };
    handleNotification(JSON.stringify({ origin: firstPayload.origin, message: outbound }));
    handleNotification(
      JSON.stringify({
        origin: 'remote-process',
        message: {
          ...outbound,
          publicEvent: {
            ...outbound.publicEvent,
            blockNumber: 12,
            transactionHash: '0xccc',
            logIndex: 2,
          },
        },
      }),
    );

    expect(received).toEqual([
      outbound,
      {
        ...outbound,
        publicEvent: {
          ...outbound.publicEvent,
          blockNumber: 12,
          transactionHash: '0xccc',
          logIndex: 2,
        },
      },
    ]);

    subscription.unsubscribe();
    await service.onModuleDestroy();
    expect(stop).toHaveBeenCalled();
  });
});
