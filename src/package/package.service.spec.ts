import { Test, TestingModule } from '@nestjs/testing';
import { PackageService } from './package.service.js';
import JSZip from 'jszip';
import { ArchiveStorageService } from '../storage/archive-storage.service.js';

jest.mock('@ownables/core/utils', () => ({
  calculateOwnablePackageCid: (entries: Array<{ path: string; content: Buffer }>) =>
    `cid-${entries.map((entry) => entry.path).sort().join('-')}`,
}));

describe('PackageService', () => {
  let service: PackageService;
  let module: TestingModule;
  const storage = {
    storePackageArtifacts: jest.fn().mockResolvedValue(undefined),
    hasPackage: jest.fn().mockResolvedValue(false),
    packageAssetKey: jest.fn((cid: string, file: string) => `archives/packages/${cid}/${file}`),
    packageZipKey: jest.fn((cid: string) => `archives/packages/${cid}/${cid}.zip`),
    getPackageZip: jest.fn().mockResolvedValue(Buffer.from('zip-data')),
  };

  async function createArchive(files: Record<string, string>): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [filename, content] of Object.entries(files)) {
      zip.file(filename, content);
    }
    return await zip.generateAsync({ type: 'uint8array' });
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    module = await Test.createTestingModule({
      providers: [PackageService, ArchiveStorageService],
    })
      .overrideProvider(ArchiveStorageService)
      .useValue(storage)
      .compile();
    await module.init();

    service = module.get<PackageService>(PackageService);
  });

  afterEach(async () => module.close());

  it('stores sequential archives with disjoint file maps and excludes chain.json from CID inputs', async () => {
    const firstArchive = await createArchive({
      'package.json': '{}',
      'first-sentinel.txt': 'first',
      'chain.json': '{"id":"first-chain"}',
    });
    const secondArchive = await createArchive({
      'package.json': '{}',
      'second-sentinel.txt': 'second',
      'chain.json': '{"id":"second-chain"}',
    });

    const firstCid = await service.store(firstArchive);
    const secondCid = await service.store(secondArchive);

    expect(firstCid).toBe('cid-first-sentinel.txt-package.json');
    expect(secondCid).toBe('cid-package.json-second-sentinel.txt');
    expect(storage.storePackageArtifacts).toHaveBeenNthCalledWith(
      1,
      firstCid,
      firstArchive,
      expect.any(Map),
    );
    expect(storage.storePackageArtifacts).toHaveBeenNthCalledWith(
      2,
      secondCid,
      secondArchive,
      expect.any(Map),
    );

    const firstFiles = storage.storePackageArtifacts.mock.calls[0][2] as Map<string, Buffer>;
    const secondFiles = storage.storePackageArtifacts.mock.calls[1][2] as Map<string, Buffer>;
    expect([...firstFiles.keys()]).toEqual(['package.json', 'first-sentinel.txt']);
    expect([...secondFiles.keys()]).toEqual(['package.json', 'second-sentinel.txt']);
    expect(secondFiles.has('first-sentinel.txt')).toBe(false);
    expect(secondFiles.get('second-sentinel.txt')?.toString()).toBe('second');
  });

  it('keeps concurrent archive loads disjoint', async () => {
    const firstArchive = await createArchive({ 'package.json': '{}', 'parallel-first.txt': 'first' });
    const secondArchive = await createArchive({ 'package.json': '{}', 'parallel-second.txt': 'second' });

    const [firstCid, secondCid] = await Promise.all([service.store(firstArchive), service.store(secondArchive)]);

    const storedCalls = storage.storePackageArtifacts.mock.calls as Array<[string, Uint8Array, Map<string, Buffer>]>;
    const firstFiles = storedCalls.find(([cid]) => cid === firstCid)?.[2];
    const secondFiles = storedCalls.find(([cid]) => cid === secondCid)?.[2];
    expect(firstFiles).toBeDefined();
    expect(secondFiles).toBeDefined();
    expect([...firstFiles!.keys()]).toEqual(['package.json', 'parallel-first.txt']);
    expect([...secondFiles!.keys()]).toEqual(['package.json', 'parallel-second.txt']);
    expect(firstFiles!.has('parallel-second.txt')).toBe(false);
    expect(secondFiles!.has('parallel-first.txt')).toBe(false);
  });

  it('returns cid without writing when package exists', async () => {
    storage.hasPackage.mockResolvedValueOnce(true);

    const archive = await createArchive({ 'package.json': '{}', 'existing.txt': 'existing' });
    const cid = await service.store(archive);

    expect(cid).toBe('cid-existing.txt-package.json');
    expect(storage.storePackageArtifacts).not.toHaveBeenCalled();
  });

  it("rejects archives without package.json", async () => {
    const archive = await createArchive({ 'only-file.txt': 'missing package manifest' });

    await expect(service.store(archive)).rejects.toThrow(
      "Invalid package: 'package.json' is missing",
    );
    expect(storage.storePackageArtifacts).not.toHaveBeenCalled();
  });

  it('loads stored archives for zipped and hasMethod lookups', async () => {
    const archive = await createArchive({
      'package.json': '{}',
      'instantiate_msg.json': JSON.stringify({ oneOf: [{ required: ['create'] }] }),
    });
    storage.getPackageZip.mockResolvedValue(archive);

    const zipped = await service.zipped('cid-archive');

    expect(await zipped.file('package.json')?.async('string')).toBe('{}');
    await expect(service.hasMethod('cid-archive', 'instantiate', 'create')).resolves.toBe(true);
    await expect(service.hasMethod('cid-archive', 'instantiate', 'missing')).resolves.toBe(false);
    await expect(service.hasMethod('cid-archive', 'execute', 'create')).resolves.toBe(false);
  });

  it('uses archive keys for file lookup', () => {
    expect(service.file('abc', 'package.json')).toBe('archives/packages/abc/package.json');
    expect(service.file('abc')).toBe('archives/packages/abc/abc.zip');
  });
});
