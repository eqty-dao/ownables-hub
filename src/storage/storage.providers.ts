import { ConfigService } from '../common/config/config.service.js';
import { OWNABLES_BUCKET } from './storage.tokens.js';
import { Bucket } from 'any-bucket';

type LocalBucketCtor = new (path: string) => Bucket;

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
        const localBucketMod = (await import('any-bucket/local')) as unknown as { default: LocalBucketCtor };
        return new localBucketMod.default(localPath);
      }

      throw new Error(`Unsupported OWNABLES_STORAGE DSN: ${dsn}`);
    },
    inject: [ConfigService],
  },
];
