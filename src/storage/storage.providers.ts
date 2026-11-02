import { ConfigService } from '../common/config/config.service';
import { OWNABLES_BUCKET, QUARANTINE_BUCKET } from './storage.tokens';
import { Bucket } from 'any-bucket';

type LocalBucketCtor = new (path: string) => Bucket;
type LocalBucketModule = {
  default?: LocalBucketCtor | { default?: LocalBucketCtor };
  'module.exports'?: LocalBucketCtor | { default?: LocalBucketCtor };
};

type S3BucketCtor = new (client: unknown, bucket: string) => Bucket;
type S3BucketModule = { default?: S3BucketCtor | { default?: S3BucketCtor } };
type S3ClientCtor = new (config?: { endpoint?: string; region?: string; forcePathStyle?: boolean }) => unknown;
type S3ClientModule = { S3?: S3ClientCtor };

function resolveLocalBucketCtor(module: LocalBucketModule): LocalBucketCtor {
  const candidate = module.default ?? module['module.exports'];
  if (typeof candidate === 'function') {
    return candidate;
  }
  if (candidate && typeof candidate.default === 'function') {
    return candidate.default;
  }

  throw new Error('Unable to load any-bucket local storage provider');
}

function resolveS3BucketCtor(module: S3BucketModule): S3BucketCtor {
  const candidate = module.default;
  if (typeof candidate === 'function') return candidate;
  if (candidate && typeof candidate.default === 'function') return candidate.default;
  throw new Error('Unable to load any-bucket S3 storage provider');
}

async function createBucket(dsn: string, label = 'storage'): Promise<Bucket> {
  const normalized = dsn.trim();
  const localPath = normalized.startsWith('file://') ? normalized.slice('file://'.length) : normalized;
  if (normalized.startsWith('file://') || !normalized.includes('://')) {
    const localBucketMod = (await import('any-bucket/local')) as unknown as LocalBucketModule;
    return new (resolveLocalBucketCtor(localBucketMod))(localPath);
  }

  if (!normalized.startsWith('s3://')) {
    throw new Error(`Unsupported ${label} DSN: ${normalized}`);
  }
  const url = new URL(normalized);
  if (!url.hostname) throw new Error(`Invalid S3 storage DSN: ${normalized}`);
  const s3BucketMod = (await import('any-bucket/s3')) as unknown as S3BucketModule;
  const s3ClientMod = (await import('@aws-sdk/client-s3')) as unknown as S3ClientModule;
  if (!s3ClientMod.S3) throw new Error('Unable to load AWS S3 client');
  const endpoint = url.searchParams.get('endpoint') || process.env.AWS_ENDPOINT_URL || undefined;
  const region = url.searchParams.get('region') || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
  const forcePathStyle = url.searchParams.get('forcePathStyle') === 'true';
  const client = new s3ClientMod.S3({ endpoint, region, forcePathStyle });
  const prefix = url.pathname.replace(/^\/+|\/+$/g, '');
  return new (resolveS3BucketCtor(s3BucketMod))(client, prefix ? `${url.hostname}/${prefix}` : url.hostname);
}

export const storageProviders = [
  {
    provide: OWNABLES_BUCKET,
    useFactory: async (config: ConfigService): Promise<Bucket> => {
      const dsn = config.getAppConfig().ownablesStorage.trim();
      if (!dsn) {
        throw new Error('OWNABLES_STORAGE is required');
      }

      return createBucket(dsn, 'OWNABLES_STORAGE');
    },
    inject: [ConfigService],
  },
  {
    provide: QUARANTINE_BUCKET,
    useFactory: async (config: ConfigService): Promise<Bucket> => createBucket(config.getAppConfig().quarantineStorage, 'QUARANTINE_STORAGE'),
    inject: [ConfigService],
  },
];
