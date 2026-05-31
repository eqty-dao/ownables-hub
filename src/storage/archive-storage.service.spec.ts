import { ArchiveStorageService } from './archive-storage.service.js';

describe('ArchiveStorageService', () => {
  const put = jest.fn();
  const get = jest.fn();
  const bucket = { put, get };
  let service: ArchiveStorageService;

  beforeEach(() => {
    put.mockReset();
    get.mockReset();
    service = new ArchiveStorageService(bucket as any);
  });

  it('stores package zip and extracted files under archive keys', async () => {
    const files = new Map<string, Buffer>([
      ['package.json', Buffer.from('{}')],
      ['assets/a.txt', Buffer.from('a')],
    ]);

    await service.storePackageArtifacts('cid-1', new Uint8Array([1, 2, 3]), files);

    expect(put).toHaveBeenCalledWith('archives/packages/cid-1/cid-1.zip', expect.any(Buffer));
    expect(put).toHaveBeenCalledWith('archives/packages/cid-1/package.json', Buffer.from('{}'));
    expect(put).toHaveBeenCalledWith('archives/packages/cid-1/assets/a.txt', Buffer.from('a'));
  });

  it('uses chain archive key for event chain storage', async () => {
    await service.storeEventChain('cid-2', Buffer.from('chain'));
    expect(put).toHaveBeenCalledWith('archives/chains/cid-2/eventChain.json', Buffer.from('chain'));
  });

  it('normalizes returned data to Buffer', async () => {
    get.mockResolvedValueOnce(new Uint8Array([4, 5]));
    const zip = await service.getPackageZip('cid-3');
    expect(zip).toEqual(Buffer.from([4, 5]));
  });
});
