import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { NotifyPublisherService, type NotifyPublisherTransport } from '@ownables/notify-publisher';
import { ethers } from 'ethers';
import { ConfigService } from '../common/config/config.service.js';
import { resolveCaip2Reference } from '../common/config/evm-network.util.js';
import { HubStateRepository, type NotifyDeliveryStateRow } from '../persistence/repos/hub-state.repository.js';
import { ReownNotifyTransport, ReownTransportError } from './reown-notify.transport.js';

export type NotifyTriggerKind = 'upload' | 'download_replay';
export type NotifyDeliveryStatus = 'delivered' | 'not_subscribed' | 'failed_configuration' | 'failed_transient' | 'failed_permanent';
export const NOTIFY_PUBLISHER_TRANSPORT = Symbol('NOTIFY_PUBLISHER_TRANSPORT');

export interface NotifyOwnableInput {
  ownerAddress: string;
  ownerNetwork?: string | null;
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

export interface NotifyOwnableResult {
  status: NotifyDeliveryStatus;
  ownerAccount: string | null;
  warningCode?: string;
  warningMessage?: string;
}

@Injectable()
export class NotifyService {
  private readonly publisher: NotifyPublisherService;
  private readonly transport: ReownNotifyTransport;

  constructor(
    private readonly hubState: HubStateRepository,
    private readonly config: ConfigService,
    @Optional()
    @Inject(NOTIFY_PUBLISHER_TRANSPORT)
    transport?: NotifyPublisherTransport,
  ) {
    this.transport =
      transport && 'getSubscriber' in transport
        ? (transport as ReownNotifyTransport)
        : new ReownNotifyTransport(this.config);
    this.publisher = new NotifyPublisherService(transport ?? this.transport);
  }

  async notifyOwnableAvailability(input: NotifyOwnableInput): Promise<NotifyOwnableResult> {
    const ownerAccount = this.deriveOwnerAccount(input.ownerAddress, input.ownerNetwork ?? input.nftNetwork ?? null);
    if (!ownerAccount) {
      return this.persistWarning(input, null, 'failed_configuration', 'owner_account_derivation_failed', 'Unable to derive CAIP-10 owner account.');
    }

    const notificationId = this.buildNotificationId(input, ownerAccount);
    const existing = await this.hubState.getNotifyDeliveryStateByDedupKey({
      ownableId: input.ownableId,
      ownerAccount,
      ownerStateVersion: input.ownerStateVersion,
      triggerKind: input.triggerKind,
    });
    if (existing?.status === 'delivered') {
      return { status: 'delivered', ownerAccount };
    }

    const attemptCount = (existing?.attemptCount ?? 0) + 1;
    const configIssue = this.config.getReownConfigIssue();
    if (configIssue) {
      return this.persistWarning(input, ownerAccount, 'failed_configuration', configIssue.code, configIssue.message, {
        existing,
        attemptCount,
        notificationId,
      });
    }

    const downloadUrl = this.buildDownloadUrl(input.cid);
    const reownConfig = this.config.getReownConfig();
    if (!reownConfig) {
      return this.persistWarning(input, ownerAccount, 'failed_configuration', 'missing_reown_config', 'Reown notify configuration is unavailable.', {
        existing,
        attemptCount,
        notificationId,
      });
    }

    try {
      const subscriber = await this.transport.getSubscriber(ownerAccount);
      if (!subscriber.subscribed || !subscriber.notificationTypes.includes(reownConfig.notificationTypeId)) {
        return this.persistWarning(
          input,
          ownerAccount,
          'not_subscribed',
          'reown_not_subscribed',
          'Account is not subscribed to the configured notification type.',
          {
            existing,
            attemptCount,
            notificationId,
            notificationType: reownConfig.notificationTypeId,
          },
        );
      }

      const publishResult = await this.publisher.publishOwnableAvailable({
        eventId: notificationId,
        target: { account: ownerAccount },
        ownableId: input.ownableId,
        cid: input.cid,
        scope: 'direct',
        issuerAddress: input.issuerAddress,
        ownerAccount,
        ownerAddress: input.ownerAddress,
        url: downloadUrl,
        ...(input.nftNetwork && input.nftContractAddress && input.nftTokenId
          ? { nft: { network: input.nftNetwork, contract: input.nftContractAddress, tokenId: input.nftTokenId } }
          : {}),
      });

      await this.hubState.upsertNotifyDeliveryState({
        ownableId: input.ownableId,
        ownerAddress: input.ownerAddress,
        ownerAccount,
        ownerStateVersion: input.ownerStateVersion,
        triggerKind: input.triggerKind,
        status: 'delivered',
        notificationType: reownConfig.notificationTypeId,
        notificationId,
        transportId: publishResult.transportId ?? null,
        attemptCount,
      });

      return { status: 'delivered', ownerAccount };
    } catch (error) {
      const classified = this.classifyTransportError(error);
      return this.persistWarning(input, ownerAccount, classified.status, classified.code, classified.message, {
        existing,
        attemptCount,
        notificationId,
        notificationType: reownConfig.notificationTypeId,
      });
    }
  }

  async getDeliveryStatus(cid: string, ownerAccount: string): Promise<NotifyDeliveryStateRow | null> {
    const trimmedCid = cid.trim();
    const trimmedOwner = ownerAccount.trim();
    if (!trimmedCid) {
      throw new BadRequestException('cid is required');
    }
    if (!trimmedOwner) {
      throw new BadRequestException('owner is required');
    }

    return this.hubState.getNotifyDeliveryStateByOwnableAndOwner(trimmedCid, trimmedOwner);
  }

  private async persistWarning(
    input: NotifyOwnableInput,
    ownerAccount: string | null,
    status: Exclude<NotifyDeliveryStatus, 'delivered'>,
    warningCode: string,
    warningMessage: string,
    options: {
      existing?: NotifyDeliveryStateRow | null;
      attemptCount?: number;
      notificationId?: string | null;
      notificationType?: string | null;
    } = {},
  ): Promise<NotifyOwnableResult> {
    await this.hubState.upsertNotifyDeliveryState({
      ownableId: input.ownableId,
      ownerAddress: input.ownerAddress,
      ownerAccount: ownerAccount ?? `unknown:${input.ownerAddress.toLowerCase()}`,
      ownerStateVersion: input.ownerStateVersion,
      triggerKind: input.triggerKind,
      status,
      notificationType: options.notificationType ?? null,
      notificationId: options.notificationId ?? null,
      transportId: options.existing?.transportId ?? null,
      attemptCount: options.attemptCount ?? ((options.existing?.attemptCount ?? 0) + 1),
      errorCode: warningCode,
      lastError: warningMessage,
    });

    return {
      status,
      ownerAccount,
      warningCode,
      warningMessage,
    };
  }

  private buildDownloadUrl(cid: string): string {
    const base = this.config.getAppConfig().publicBaseUrl.trim();
    if (!base) {
      throw new BadRequestException('PUBLIC_BASE_URL is required to build notify links');
    }

    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    return new URL(`ownables/${encodeURIComponent(cid)}/download`, normalizedBase).toString();
  }

  private buildNotificationId(input: NotifyOwnableInput, ownerAccount: string): string {
    const digest = createHash('sha256')
      .update(`${input.ownableId}|${ownerAccount}|${input.ownerStateVersion}|${input.triggerKind}`)
      .digest('hex');
    return `ownables_${digest}`;
  }

  private deriveOwnerAccount(ownerAddress: string, ownerNetwork: string | null): string | null {
    if (!ownerNetwork) {
      return null;
    }

    const reference = resolveCaip2Reference(ownerNetwork, this.config.getRuntimeNetworkProfile());
    if (!reference) {
      return null;
    }

    try {
      const normalized = ethers.getAddress(ownerAddress).toLowerCase();
      return `eip155:${reference}:${normalized}`;
    } catch {
      return null;
    }
  }

  private classifyTransportError(error: unknown): { status: 'failed_configuration' | 'failed_transient' | 'failed_permanent'; code: string; message: string } {
    if (error instanceof ReownTransportError) {
      if (error.code === 'reown_auth_failed') {
        return { status: 'failed_configuration', code: error.code, message: error.message };
      }
      if (error.code === 'reown_rate_limited' || error.code === 'reown_upstream_error') {
        return { status: 'failed_transient', code: error.code, message: error.message };
      }
      return { status: 'failed_permanent', code: error.code, message: error.message };
    }

    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed_transient', code: 'reown_upstream_error', message };
  }
}
