import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { IndexedPublicEvent } from '@ownables/core';
import { PostgresService } from '../persistence/postgres.service.js';

export interface PublicEventStreamMessage {
  ownableId: string;
  publicEvent: IndexedPublicEvent;
}

export interface LiveIndexedPublicEvent {
  subjectId: string;
  publicEvent: IndexedPublicEvent;
}

export interface AvailableOwnableDiscoveryEntry {
  id: string;
  title: string;
  description?: string;
  issuer?: string;
  availableAt: string;
  package: {
    cid: string;
    thumbnailUrl?: string | null;
  };
}

export interface AvailableOwnableDiscoveryMessage {
  owner: string;
  entry: AvailableOwnableDiscoveryEntry;
}

@Injectable()
export class OwnableTransportService implements OnModuleInit, OnModuleDestroy {
  private static readonly PUBLIC_EVENT_CHANNEL = 'ownables_public_events';
  private readonly logger = new Logger(OwnableTransportService.name);
  private readonly publicEventSubject = new Subject<LiveIndexedPublicEvent>();
  private readonly discoverySubject = new Subject<AvailableOwnableDiscoveryMessage>();
  private readonly instanceId = randomUUID();
  private stopPublicEventBridge: (() => Promise<void>) | null = null;

  constructor(private readonly postgres: PostgresService) {}

  async onModuleInit(): Promise<void> {
    this.stopPublicEventBridge = await this.postgres.listen(OwnableTransportService.PUBLIC_EVENT_CHANNEL, (payload) => {
      try {
        const message = JSON.parse(payload) as { origin?: string; message?: LiveIndexedPublicEvent };
        if (!message.message || message.origin === this.instanceId) {
          return;
        }
        this.publicEventSubject.next(message.message);
      } catch (error) {
        this.logger.error(
          'Failed to decode cross-process public-event notification',
          error instanceof Error ? error.stack : String(error),
        );
      }
    });
  }

  publishPublicEvent(message: LiveIndexedPublicEvent): void {
    this.publicEventSubject.next(message);
    void this.postgres
      .notify(
        OwnableTransportService.PUBLIC_EVENT_CHANNEL,
        JSON.stringify({
          origin: this.instanceId,
          message,
        }),
      )
      .catch((error) => {
        this.logger.error(
          'Failed to publish cross-process public-event notification',
          error instanceof Error ? error.stack : String(error),
        );
      });
  }

  watchPublicEvents(): Observable<LiveIndexedPublicEvent> {
    return this.publicEventSubject.asObservable();
  }

  publishAvailableOwnable(message: AvailableOwnableDiscoveryMessage): void {
    this.discoverySubject.next(message);
  }

  watchAvailableOwnables(): Observable<AvailableOwnableDiscoveryMessage> {
    return this.discoverySubject.asObservable();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopPublicEventBridge?.();
    this.stopPublicEventBridge = null;
  }
}
