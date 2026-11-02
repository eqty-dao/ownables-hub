import { storageProviders } from './storage.providers';
import { QuarantineStorageService } from './quarantine-storage.service';

jest.mock('@aws-sdk/client-s3', () => ({ S3: jest.fn() }));
jest.mock('any-bucket/s3', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    put: jest.fn(),
    get: jest.fn(),
    has: jest.fn(),
    delete: jest.fn(),
    list: jest.fn(),
  })),
}));

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

  it('builds the separate quarantine bucket from its own DSN', async () => {
    const factory = storageProviders[1]?.useFactory as (config: any) => Promise<any>;
    const config = { getAppConfig: () => ({ quarantineStorage: 'file://tmp/quarantine' }) };

    const bucket = await factory(config);

    expect(bucket).toBeDefined();
    expect(typeof bucket.put).toBe('function');
    expect(typeof bucket.delete).toBe('function');
  });

  it('uses the configured S3 quarantine bucket only through private upload keys', async () => {
    const S3Bucket = jest.requireMock('any-bucket/s3').default as jest.Mock;
    const factory = storageProviders[1]?.useFactory as (config: any) => Promise<any>;
    const bucket = await factory({ getAppConfig: () => ({ quarantineStorage: 's3://private-bucket/quarantine' }) });
    bucket.has.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    bucket.get.mockResolvedValue(Buffer.from('contents'));
    const storage = new QuarantineStorageService(bucket);

    const key = await storage.store('digest', Buffer.from('contents'));
    await storage.exists(key);
    await storage.read(key);
    await storage.remove(key);

    expect(S3Bucket).toHaveBeenCalledWith(expect.anything(), 'private-bucket/quarantine');
    expect(key).toBe('quarantine/uploads/digest.zip');
    expect(bucket.put).toHaveBeenCalledWith(key, Buffer.from('contents'));
    expect(bucket.get).toHaveBeenCalledWith(key);
    expect(bucket.delete).toHaveBeenCalledWith(key);
  });

  it('fails the S3 quarantine startup probe when private storage is unavailable', async () => {
    const factory = storageProviders[1]?.useFactory as (config: any) => Promise<any>;
    const bucket = await factory({ getAppConfig: () => ({ quarantineStorage: 's3://private-bucket/quarantine' }) });
    bucket.put.mockRejectedValue(new Error('S3 unavailable'));

    await expect(new QuarantineStorageService(bucket).probe()).rejects.toThrow('S3 unavailable');
  });

  it('rejects unsupported remote DSN', async () => {
    const factory = storageProviders[0]?.useFactory as (config: any) => Promise<any>;
    const config = { getAppConfig: () => ({ ownablesStorage: 'gs://my-bucket' }) };

    await expect(factory(config)).rejects.toThrow('Unsupported OWNABLES_STORAGE DSN: gs://my-bucket');
  });
});
