export interface OwnablesNotificationPublishRequest {
  account: string;
  title: string;
  body: string;
  url: string;
  payload?: {
    eventId?: string;
  };
}

export interface NotifyPublisherTransport {
  publish(request: OwnablesNotificationPublishRequest): Promise<{ transportId?: string }>;
}

export class NotifyPublisherService {
  constructor(private readonly transport: NotifyPublisherTransport) {
    void this.transport;
  }

  async publishOwnableAvailable(input: {
    eventId?: string;
    target: { account: string };
    url: string;
  }): Promise<{ transportId?: string; eventId: string }> {
    const eventId = input.eventId ?? 'evt_test';
    const result = await this.transport.publish({
      account: input.target.account,
      title: 'Ownable available',
      body: 'Open the ownable download link.',
      url: input.url,
      payload: { eventId },
    });
    return { eventId, transportId: result.transportId };
  }
}
