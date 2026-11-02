import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '../common/config/config.service';
import { CapacityError, ConflictError } from '../interfaces/error';
import {
  HubStateRepository,
  type QuarantinedOwnableUpload,
  type QuarantineUploadInput,
} from '../persistence/repos/hub-state.repository';
import { QuarantineStorageService } from '../storage/quarantine-storage.service';

@Injectable()
export class QuarantineService implements OnModuleInit {
  private readonly promoterId = `hub-${randomUUID()}`;

  constructor(
    private readonly config: ConfigService,
    private readonly hubState: HubStateRepository,
    private readonly storage: QuarantineStorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.storage.probe();
  }

  digest(contents: Uint8Array): string {
    return this.storage.digest(contents);
  }

  async findExactRetry(uploadDigest: string): Promise<{ pending: QuarantinedOwnableUpload | null; available: { ownableId: string; cid: string } | null }> {
    const pending = await this.hubState.findActiveQuarantineByDigest(uploadDigest);
    if (pending) return { pending, available: null };
    const available = await this.hubState.getOwnableByUploadDigest(uploadDigest);
    if (!available?.ownableId) return { pending: null, available: null };
    return { pending: null, available: { ownableId: available.ownableId, cid: available.packageCid } };
  }

  async stage(
    input: Omit<QuarantineUploadInput, 'retentionSeconds' | 'maxPendingObjects' | 'maxPendingBytes' | 'privateObjectKey'>,
    contents: Uint8Array,
    processingStartedAt = Date.now(),
  ): Promise<QuarantinedOwnableUpload> {
    const settings = this.config.getAppConfig().quarantine;
    await this.cleanup();
    const existing = await this.hubState.findActiveQuarantineByDigest(input.uploadDigest);
    if (existing) return existing;
    const activeSubject = await this.hubState.findActiveQuarantineBySubjectId(input.subjectId);
    if (activeSubject) {
      throw new ConflictError('OWNABLE_UPLOAD_CONFLICT', 'A different upload for this Ownable is already pending verification');
    }
    const key = await this.storage.store(input.uploadDigest, contents);
    try {
      const staged = await this.hubState.createQuarantinedUpload({
        ...input,
        privateObjectKey: key,
        retentionSeconds: settings.retentionSeconds,
        maxPendingObjects: settings.maxPendingObjects,
        maxPendingBytes: settings.maxPendingBytes,
      });
      const resourceUsage = process.resourceUsage();
      console.log(
        JSON.stringify({
          event: 'quarantine_staged',
          profile: process.env.STORY10_RESOURCE_PROFILE,
          uploadId: staged.id,
          compressedBytes: input.compressedBytes,
          expandedBytes: input.expandedBytes,
          storedBytes: input.compressedBytes,
          processingMilliseconds: Date.now() - processingStartedAt,
          maxRssBytes: resourceUsage.maxRSS * 1024,
          memoryUsage: process.memoryUsage(),
        }),
      );
      return staged;
    } catch (error) {
      const matchingUpload = await this.hubState.findActiveQuarantineByDigest(input.uploadDigest);
      if (matchingUpload) return matchingUpload;
      if (!(await this.hubState.privateObjectIsReferenced(key))) await this.storage.remove(key);
      if (await this.hubState.findActiveQuarantineBySubjectId(input.subjectId)) {
        throw new ConflictError('OWNABLE_UPLOAD_CONFLICT', 'A different upload for this Ownable is already pending verification');
      }
      if (error instanceof Error && error.message === 'QUARANTINE_CAPACITY_EXHAUSTED') {
        throw new CapacityError(503, 'QUARANTINE_CAPACITY_EXHAUSTED', 'Quarantine capacity is exhausted');
      }
      throw error;
    }
  }

  async load(upload: QuarantinedOwnableUpload): Promise<Buffer> {
    return this.storage.read(upload.privateObjectKey);
  }

  async claimForPromotion(): Promise<QuarantinedOwnableUpload[]> {
    const settings = this.config.getAppConfig().quarantine;
    return this.hubState.claimQuarantinedUploads(this.promoterId, settings.promotionBatchSize, settings.leaseSeconds);
  }

  async claim(uploadId: string): Promise<QuarantinedOwnableUpload | null> {
    const settings = this.config.getAppConfig().quarantine;
    return this.hubState.claimQuarantinedUpload(uploadId, this.promoterId, settings.leaseSeconds);
  }

  async defer(uploadId: string): Promise<void> {
    await this.hubState.restoreQuarantinePending(uploadId, 'MISSING_INDEXED_EVIDENCE');
  }

  async reject(uploadId: string, reason: string, detail?: string): Promise<void> {
    await this.hubState.rejectQuarantinedUpload(uploadId, reason, detail);
  }

  async cleanup(): Promise<void> {
    const settings = this.config.getAppConfig().quarantine;
    const expired = await this.hubState.expireQuarantinedUploads(settings.cleanupBatchSize);
    for (const upload of expired) {
      if (!(await this.hubState.privateObjectIsReferenced(upload.privateObjectKey))) {
        try {
          await this.storage.remove(upload.privateObjectKey);
          await this.hubState.markPrivateObjectDeleted(upload.id);
        } catch (error) {
          console.error('Failed to delete expired quarantine object', error);
        }
      }
    }
  }

  async cleanupPrivateObject(upload: Pick<QuarantinedOwnableUpload, 'id' | 'privateObjectKey'>): Promise<void> {
    if (!(await this.hubState.privateObjectIsReferenced(upload.privateObjectKey))) {
      try {
        await this.storage.remove(upload.privateObjectKey);
        await this.hubState.markPrivateObjectDeleted(upload.id);
      } catch (error) {
        console.error('Failed to delete quarantine object', error);
      }
    }
  }

  async acquireIngress(): Promise<() => Promise<void>> {
    const settings = this.config.getAppConfig().quarantine;
    try {
      const id = await this.hubState.acquireIngressLease({
        concurrency: settings.ingressConcurrency,
        rateWindowSeconds: settings.rateLimitWindowSeconds,
        rateMaxRequests: settings.rateLimitMaxRequests,
        leaseSeconds: settings.leaseSeconds,
      });
      return async () => this.hubState.releaseIngressLease(id);
    } catch (error) {
      if (error instanceof Error && error.message === 'UPLOAD_RATE_LIMITED') {
        throw new CapacityError(429, 'UPLOAD_RATE_LIMITED', 'Upload rate limit is exhausted');
      }
      if (error instanceof Error && error.message === 'QUARANTINE_CAPACITY_EXHAUSTED') {
        throw new CapacityError(503, 'QUARANTINE_CAPACITY_EXHAUSTED', 'Upload ingress capacity is exhausted');
      }
      throw error;
    }
  }

  async acquireProcessing(): Promise<() => Promise<void>> {
    const settings = this.config.getAppConfig().quarantine;
    try {
      const id = await this.hubState.acquireProcessingLease({
        concurrency: settings.processingConcurrency,
        reservedBytes: settings.maxExpandedProcessingBytes,
        maxReservedBytes: settings.maxExpandedProcessingBytes,
        leaseSeconds: settings.leaseSeconds,
      });
      return async () => this.hubState.releaseProcessingLease(id);
    } catch (error) {
      if (error instanceof Error && error.message === 'QUARANTINE_CAPACITY_EXHAUSTED') {
        throw new CapacityError(503, 'QUARANTINE_CAPACITY_EXHAUSTED', 'Upload processing capacity is exhausted');
      }
      throw error;
    }
  }
}
