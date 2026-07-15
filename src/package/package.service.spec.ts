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
  const zip = {
    loadAsync: jest.fn(() => ({
      files: {
        'package.json': { async: jest.fn(() => Promise.resolve('{}')) },
        foo: { async: jest.fn(() => Promise.resolve('_foo_')) },
      },
    })),
  } as unknown as JSZip;

  const storage = {
    storePackageArtifacts: jest.fn().mockResolvedValue(undefined),
    hasPackage: jest.fn().mockResolvedValue(false),
    packageAssetKey: jest.fn((cid: string, file: string) => `archives/packages/${cid}/${file}`),
    packageZipKey: jest.fn((cid: string) => `archives/packages/${cid}/${cid}.zip`),
    getPackageZip: jest.fn().mockResolvedValue(Buffer.from('zip-data')),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PackageService,
        { provide: JSZip, useValue: zip },
        { provide: ArchiveStorageService, useValue: storage },
      ],
    }).compile();
    await module.init();

    service = module.get<PackageService>(PackageService);
  });

  it('stores package artifacts in archive storage when cid is new', async () => {
    const buffer = new Uint8Array([1, 2, 3]);

    const cid = await service.store(buffer);

    expect(cid).toBe('cid-foo-package.json');
    expect(storage.storePackageArtifacts).toHaveBeenCalledWith(
      'cid-foo-package.json',
      buffer,
      expect.any(Map),
    );
  });

  it('returns cid without writing when package exists', async () => {
    storage.hasPackage.mockResolvedValueOnce(true);

    const cid = await service.store(new Uint8Array([1, 2, 3]));

    expect(cid).toBe('cid-foo-package.json');
    expect(storage.storePackageArtifacts).not.toHaveBeenCalled();
  });

  it('uses archive keys for file lookup', () => {
    expect(service.file('abc', 'package.json')).toBe('archives/packages/abc/package.json');
    expect(service.file('abc')).toBe('archives/packages/abc/abc.zip');
  });
});
