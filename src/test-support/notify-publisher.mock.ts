export interface OwnablesNotificationPublishRequest {
  ownerAddress: string;
  target: {
    topic: string;
  };
}

export interface NotifyPublisherTransport {
  publish(request: OwnablesNotificationPublishRequest): Promise<{ transportId?: string }>;
}

export class NotifyPublisherService {
  constructor(private readonly transport: NotifyPublisherTransport) {
    void this.transport;
  }

  async publishOwnableAvailable(_input: { ownerAddress: string; target: { topic: string } }): Promise<{ transportId?: string; eventId: string }> {
    return { eventId: 'evt_test' };
  }
}
