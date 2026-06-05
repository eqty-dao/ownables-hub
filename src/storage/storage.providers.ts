import { ConfigService } from '../common/config/config.service.js';
import { OWNABLES_BUCKET } from './storage.tokens.js';
import { Bucket } from 'any-bucket';

type LocalBucketCtor = new (path: string) => Bucket;
type LocalBucketModule = {
  default?: LocalBucketCtor | { default?: LocalBucketCtor };
  'module.exports'?: LocalBucketCtor | { default?: LocalBucketCtor };
};

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

export const storageProviders = [
  {
    provide: OWNABLES_BUCKET,
    useFactory: async (config: ConfigService): Promise<Bucket> => {
      const dsn = config.getAppConfig().ownablesStorage.trim();
      if (!dsn) {
        throw new Error('OWNABLES_STORAGE is required');
      }

      const localPath = dsn.startsWith('file://') ? dsn.slice('file://'.length) : dsn;
      if (dsn.startsWith('file://') || !dsn.includes('://')) {
        const localBucketMod = (await import('any-bucket/local')) as unknown as LocalBucketModule;
        const LocalBucket = resolveLocalBucketCtor(localBucketMod);
        return new LocalBucket(localPath);
      }

      throw new Error(`Unsupported OWNABLES_STORAGE DSN: ${dsn}`);
    },
    inject: [ConfigService],
  },
];
