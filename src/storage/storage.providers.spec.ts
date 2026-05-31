import { storageProviders } from './storage.providers.js';

describe('storageProviders', () => {
  it('builds a local bucket for file:// DSN', async () => {
    const factory = storageProviders[0]?.useFactory as (config: any) => Promise<any>;
    const config = { getAppConfig: () => ({ ownablesStorage: 'file://tmp/ownables' }) };

    const bucket = await factory(config);

    expect(bucket).toBeDefined();
    expect(typeof bucket.put).toBe('function');
    expect(typeof bucket.get).toBe('function');
  });

  it('builds a local bucket for plain local path DSN', async () => {
    const factory = storageProviders[0]?.useFactory as (config: any) => Promise<any>;
    const config = { getAppConfig: () => ({ ownablesStorage: './storage' }) };

    const bucket = await factory(config);

    expect(bucket).toBeDefined();
    expect(typeof bucket.put).toBe('function');
    expect(typeof bucket.get).toBe('function');
  });

  it('rejects unsupported remote DSN', async () => {
    const factory = storageProviders[0]?.useFactory as (config: any) => Promise<any>;
    const config = { getAppConfig: () => ({ ownablesStorage: 'gs://my-bucket' }) };

    await expect(factory(config)).rejects.toThrow('Unsupported OWNABLES_STORAGE DSN: gs://my-bucket');
  });
});
