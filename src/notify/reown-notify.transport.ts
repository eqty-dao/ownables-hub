import type { OwnablesNotificationPublishRequest, NotifyPublisherTransport } from '@ownables/notify-publisher';
import type { ConfigService, ReownConfig } from '../common/config/config.service.js';

export interface ReownSubscriberLookupResult {
  subscribed: boolean;
  notificationTypes: string[];
}

type ReownTransportErrorCode = 'reown_auth_failed' | 'reown_bad_request' | 'reown_rate_limited' | 'reown_upstream_error';

export class ReownTransportError extends Error {
  constructor(
    readonly code: ReownTransportErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class ReownNotifyTransport implements NotifyPublisherTransport {
  constructor(private readonly config: ConfigService) {}

  async getSubscriber(account: string): Promise<ReownSubscriberLookupResult> {
    const reown = this.requireConfig();
    const response = await fetch(`https://notify.walletconnect.com/v1/${reown.projectId}/subscribers`, {
      method: 'POST',
      headers: this.buildHeaders(reown),
      body: JSON.stringify({ accounts: [account] }),
    });
    if (!response.ok) {
      throw await this.toTransportError(response, 'subscriber preflight failed');
    }

    const payload = (await this.parseJson(response)) as Record<string, { notification_types?: string[] }> | null;
    const subscriber = payload?.[account];
    return {
      subscribed: Boolean(subscriber),
      notificationTypes: Array.isArray(subscriber?.notification_types) ? subscriber.notification_types : [],
    };
  }

  async publish(request: OwnablesNotificationPublishRequest): Promise<{ transportId?: string }> {
    const reown = this.requireConfig();
    const response = await fetch(`https://notify.walletconnect.com/${reown.projectId}/notify`, {
      method: 'POST',
      headers: this.buildHeaders(reown),
      body: JSON.stringify({
        notification_id: request.payload?.eventId ?? undefined,
        notification: {
          type: reown.notificationTypeId,
          title: request.title,
          body: request.body,
          url: request.url,
        },
        accounts: [request.account],
      }),
    });
    if (!response.ok) {
      throw await this.toTransportError(response, 'notification publish failed');
    }

    const payload = (await this.parseJson(response)) as Record<string, unknown> | null;
    const transportId =
      (typeof payload?.id === 'string' ? payload.id : null) ??
      (typeof payload?.notification_id === 'string' ? payload.notification_id : null) ??
      response.headers.get('x-request-id') ??
      undefined;

    return transportId ? { transportId } : {};
  }

  private buildHeaders(reown: ReownConfig): Record<string, string> {
    return {
      Authorization: `Bearer ${reown.notifyApiSecret}`,
      'Content-Type': 'application/json',
    };
  }

  private requireConfig(): ReownConfig {
    const reown = this.config.getReownConfig();
    if (!reown) {
      throw new ReownTransportError('reown_bad_request', 500, 'Reown transport requires complete runtime configuration.');
    }
    return reown;
  }

  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  private async toTransportError(response: Response, defaultMessage: string): Promise<ReownTransportError> {
    const payload = (await this.parseJson(response)) as { message?: string; error?: string } | null;
    const message = payload?.message ?? payload?.error ?? `${defaultMessage} (${response.status})`;

    if (response.status === 401 || response.status === 403) {
      return new ReownTransportError('reown_auth_failed', response.status, message);
    }
    if (response.status === 429) {
      return new ReownTransportError('reown_rate_limited', response.status, message);
    }
    if (response.status >= 400 && response.status < 500) {
      return new ReownTransportError('reown_bad_request', response.status, message);
    }
    return new ReownTransportError('reown_upstream_error', response.status, message);
  }
}
