import { BadRequestException, Injectable } from '@nestjs/common';
import { NotifyPublisherService, type NotifyPublisherTransport } from '@ownables/notify-publisher';
import { HubStateRepository, type AvailableOwnableRow } from '../persistence/repos/hub-state.repository.js';
import { LocalNotifyTransport } from './local-notify.transport.js';

export type NotifyTriggerKind = 'catchup' | 'upload' | 'download_replay';

export interface RegisterNotifyInput {
  ownerAddress: string;
  topic: string;
  previousTopic?: string;
  ownerAccount?: string;
  signerAddress: string;
}

export interface NotifyOwnableInput {
  ownerAddress: string;
  ownableId: string;
  cid: string;
  ownerStateVersion: number;
  latestAppliedPublicEventId: string | null;
  issuerAddress: string;
  nftNetwork?: string | null;
  nftContractAddress?: string | null;
  nftTokenId?: string | null;
  triggerKind: NotifyTriggerKind;
}

@Injectable()
export class NotifyService {
  private readonly publisher: NotifyPublisherService;

  constructor(
    private readonly hubState: HubStateRepository,
    transport?: NotifyPublisherTransport,
  ) {
    this.publisher = new NotifyPublisherService(transport ?? new LocalNotifyTransport());
  }

  async register(input: RegisterNotifyInput): Promise<{ status: 'created' | 'refreshed' | 'replaced'; catchUpAttempted: number }> {
    const normalizedOwner = input.ownerAddress.trim().toLowerCase();
    const signer = input.signerAddress.trim().toLowerCase();
    if (normalizedOwner !== signer) {
      throw new BadRequestException('Signer and ownerAddress mismatch');
    }

    const topic = input.topic.trim();
    if (!topic) {
      throw new BadRequestException('topic is required');
    }

    const previous = input.previousTopic?.trim();
    const existing = await this.hubState.listActiveNotifyRegistrationsByOwner(normalizedOwner);
    const wasExisting = existing.some((row) => row.topic === topic);

    const registration = await this.hubState.upsertNotifyRegistration({
      ownerAddress: normalizedOwner,
      ownerAccount: input.ownerAccount?.trim() || `eip155:1:${normalizedOwner}`,
      topic,
      status: 'active',
    });

    let status: 'created' | 'refreshed' | 'replaced' = wasExisting ? 'refreshed' : 'created';
    if (previous && previous !== topic) {
      await this.hubState.markNotifyRegistrationReplaced(normalizedOwner, previous, registration.id);
      status = 'replaced';
    }

    const catchUpRows = await this.hubState.listAvailableOwnablesByOwner(normalizedOwner);
    for (const row of catchUpRows) {
      await this.publishForRegistration(registration, row, 'catchup');
    }

    return { status, catchUpAttempted: catchUpRows.length };
  }

  async notifyOwnableAvailability(input: NotifyOwnableInput): Promise<void> {
    const regs = await this.hubState.listActiveNotifyRegistrationsByOwner(input.ownerAddress);
    for (const reg of regs) {
      const row: AvailableOwnableRow = {
        ownableId: input.ownableId,
        cid: input.cid,
        ownerAddress: input.ownerAddress,
        ownerStateVersion: input.ownerStateVersion,
        latestAppliedPublicEventId: input.latestAppliedPublicEventId,
        prevOwnerAddress: input.issuerAddress,
        nftNetwork: input.nftNetwork ?? null,
        nftContractAddress: input.nftContractAddress ?? null,
        nftTokenId: input.nftTokenId ?? null,
      };
      await this.publishForRegistration(reg, row, input.triggerKind);
    }
  }

  private async publishForRegistration(
    registration: { id: string; ownerAddress: string; topic: string },
    ownable: AvailableOwnableRow,
    triggerKind: NotifyTriggerKind,
  ): Promise<void> {
    const existing = await this.hubState.getNotifyDeliveryState({
      registrationId: registration.id,
      ownableId: ownable.ownableId,
      ownerStateVersion: ownable.ownerStateVersion,
      triggerKind,
    });
    if (existing?.status === 'delivered') {
      return;
    }

    const attemptCount = (existing?.attemptCount ?? 0) + 1;

    try {
      await this.publisher.publishOwnableAvailable({
        target: { ownerAddress: ownable.ownerAddress, topic: registration.topic },
        ownableId: ownable.ownableId,
        cid: ownable.cid,
        scope: 'direct',
        issuerAddress: ownable.prevOwnerAddress,
        ownerAddress: ownable.ownerAddress,
        accept: { url: `/ownables/${ownable.cid}/download`, method: 'GET' },
        ...(ownable.nftNetwork && ownable.nftContractAddress && ownable.nftTokenId
          ? { nft: { network: ownable.nftNetwork, contract: ownable.nftContractAddress, tokenId: ownable.nftTokenId } }
          : {}),
      });

      await this.hubState.upsertNotifyDeliveryState({
        registrationId: registration.id,
        ownableId: ownable.ownableId,
        ownerStateVersion: ownable.ownerStateVersion,
        triggerKind,
        status: 'delivered',
        attemptCount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent =
        message.includes('Invalid notify target topic') ||
        message.includes('Invalid notify target ownerAddress') ||
        message.includes('Notify target ownerAddress does not match payload ownerAddress');

      await this.hubState.upsertNotifyDeliveryState({
        registrationId: registration.id,
        ownableId: ownable.ownableId,
        ownerStateVersion: ownable.ownerStateVersion,
        triggerKind,
        status: permanent ? 'failed_permanent' : 'failed_transient',
        attemptCount,
        lastError: message,
      });

      if (permanent) {
        await this.hubState.markNotifyRegistrationStale(registration.id, message);
      }
    }
  }
}
