import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { IndexedPublicEvent } from '@ownables/core';

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
export class OwnableTransportService {
  private readonly publicEventSubject = new Subject<LiveIndexedPublicEvent>();
  private readonly discoverySubject = new Subject<AvailableOwnableDiscoveryMessage>();

  publishPublicEvent(message: LiveIndexedPublicEvent): void {
    this.publicEventSubject.next(message);
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
}
