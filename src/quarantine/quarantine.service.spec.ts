import { QuarantineService } from './quarantine.service';
import { ConflictError } from '../interfaces/error';

describe('QuarantineService', () => {
  const config = {
    getAppConfig: () => ({
      quarantine: {
        retentionSeconds: 86400,
        maxPendingObjects: 4,
        maxPendingBytes: 536870912,
        promotionBatchSize: 16,
        cleanupBatchSize: 16,
        ingressConcurrency: 1,
        rateLimitWindowSeconds: 60,
        rateLimitMaxRequests: 8,
        processingConcurrency: 1,
        maxExpandedProcessingBytes: 536870912,
        leaseSeconds: 300,
      },
    }),
  };
  const repository = {
    findActiveQuarantineByDigest: jest.fn(),
    findActiveQuarantineBySubjectId: jest.fn(),
    getOwnableByUploadDigest: jest.fn(),
    createQuarantinedUpload: jest.fn(),
    expireQuarantinedUploads: jest.fn().mockResolvedValue([]),
    privateObjectIsReferenced: jest.fn(),
    markPrivateObjectDeleted: jest.fn(),
    acquireIngressLease: jest.fn(),
    releaseIngressLease: jest.fn(),
    acquireProcessingLease: jest.fn(),
    releaseProcessingLease: jest.fn(),
  };
  const storage = {
    digest: jest.fn(() => 'digest'),
    store: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('returns the original pending row for an exact retry before writing a duplicate object', async () => {
    const pending = { id: 'pending-1', ownableId: 'ownable-1', expiresAt: '2026-11-03T00:00:00.000Z' };
    repository.findActiveQuarantineByDigest.mockResolvedValue(pending);
    const service = new QuarantineService(config as any, repository as any, storage as any);

    await expect(service.findExactRetry('digest')).resolves.toEqual({ pending, available: null });
    expect(storage.store).not.toHaveBeenCalled();
  });

  it('turns an exhausted global ingress budget into a retryable capacity response', async () => {
    repository.acquireIngressLease.mockRejectedValue(new Error('QUARANTINE_CAPACITY_EXHAUSTED'));
    const service = new QuarantineService(config as any, repository as any, storage as any);

    await expect(service.acquireIngress()).rejects.toMatchObject({ status: 503, code: 'QUARANTINE_CAPACITY_EXHAUSTED' });
  });

  it('does not overwrite a distinct active candidate for the same Ownable', async () => {
    repository.findActiveQuarantineByDigest.mockResolvedValue(null);
    repository.findActiveQuarantineBySubjectId.mockResolvedValue({ id: 'pending-1' });
    const service = new QuarantineService(config as any, repository as any, storage as any);

    await expect(
      service.stage(
        {
          ownableId: 'ownable-1',
          subjectId: 'subject-1',
          packageCid: 'cid-1',
          uploadDigest: 'different-digest',
          compressedBytes: 10,
          expandedBytes: 10,
          eventChainDigest: 'chain-digest',
          previousOwnerAddress: '0x0000000000000000000000000000000000000001',
        },
        Buffer.from('contents'),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(storage.store).not.toHaveBeenCalled();
  });
});
