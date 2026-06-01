import type { NotifyPublisherTransport, OwnablesNotificationPublishRequest } from '@ownables/notify-publisher';

export class LocalNotifyTransport implements NotifyPublisherTransport {
  async publish(request: OwnablesNotificationPublishRequest): Promise<{ transportId?: string }> {
    return { transportId: `local-${request.payload.eventId}` };
  }
}
