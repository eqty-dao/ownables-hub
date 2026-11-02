import { QuarantineStorageService } from './quarantine-storage.service';

describe('QuarantineStorageService', () => {
  const bucket = { has: jest.fn(), put: jest.fn(), get: jest.fn(), delete: jest.fn(), list: jest.fn() };
  let service: QuarantineStorageService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new QuarantineStorageService(bucket as any);
  });

  it('uses a private content-addressed object key and avoids duplicate writes', async () => {
    bucket.has.mockResolvedValue(true);
    const digest = service.digest(Buffer.from('upload'));

    await expect(service.store(digest, Buffer.from('upload'))).resolves.toBe(`quarantine/uploads/${digest}.zip`);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('deletes only an existing private object', async () => {
    bucket.has.mockResolvedValueOnce(true);
    await service.remove('quarantine/uploads/a.zip');
    expect(bucket.delete).toHaveBeenCalledWith('quarantine/uploads/a.zip');
  });

  it('probes storage with a private write and delete', async () => {
    await service.probe();

    expect(bucket.put).toHaveBeenCalledWith(expect.stringMatching(/^quarantine\/probes\//), Buffer.alloc(0));
    expect(bucket.delete).toHaveBeenCalledWith(expect.stringMatching(/^quarantine\/probes\//));
  });
});
