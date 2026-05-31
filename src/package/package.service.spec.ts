import { Test, TestingModule } from '@nestjs/testing';
import { PackageService } from './package.service.js';
import { ConfigModule } from '../common/config/config.module.js';
import { calculateOwnablePackageCid } from '@ownables/core';
import * as fsModule from 'fs/promises';
import JSZip from 'jszip';
import path from 'path';

const fs = jest.mocked(fsModule);
jest.mock('fs/promises');
jest.mock('@ownables/core', () => ({
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
        bar: { async: jest.fn(() => Promise.resolve('_bar_')) },
      },
    })),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule],
      providers: [PackageService, { provide: JSZip, useValue: zip }],
    }).compile();
    await module.init();

    service = module.get<PackageService>(PackageService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('exists()', () => {
    it('returns true if package exists', async () => {
      fs.access.mockReturnValue(Promise.resolve());

      expect(await service.exists('some_cid')).toEqual(true);
      expect(fs.access).toHaveBeenCalledWith(path.join(process.cwd(), 'storage', 'packages', 'some_cid'));
    });

    it('returns false if package does not exist', async () => {
      fs.access.mockReturnValue(Promise.reject(''));

      expect(await service.exists('some_cid')).toEqual(false);
      expect(fs.access).toHaveBeenCalledWith(path.join(process.cwd(), 'storage', 'packages', 'some_cid'));
    });
  });

  describe('file()', () => {
    it('gives the path to a file in a package', () => {
      const file = service.file('some_cid', 'index.html');
      expect(file).toEqual(path.join(process.cwd(), 'storage', 'packages', 'some_cid', 'index.html'));
    });
  });

  describe('store()', () => {
    const buffer = new Uint8Array([1, 2, 3]);
    const cid = calculateOwnablePackageCid([
      { path: 'package.json', content: Buffer.from('{}') },
      { path: 'foo', content: Buffer.from('_foo_') },
      { path: 'bar', content: Buffer.from('_bar_') },
    ]);
    const uploadPath = path.join(process.cwd(), 'storage', 'packages');

    beforeEach(() => {
      fs.access.mockReset();
      fs.readlink.mockReset();

      zip.loadAsync.mockClear();
      fs.writeFile.mockClear();
      fs.rename.mockClear();
      fs.symlink.mockClear();
    });

    it('stores a new package', async () => {
      fs.access.mockReturnValue(Promise.reject());

      await expect(service.store(buffer)).resolves.toEqual(await cid);

      expect(zip.loadAsync).toHaveBeenCalledWith(buffer, { createFolders: true });
      expect(fs.writeFile).toHaveBeenCalledTimes(4);
      expect(fs.writeFile).toHaveBeenCalledWith(`${uploadPath}/${await cid}/package.json`, '{}');
      expect(fs.writeFile).toHaveBeenCalledWith(`${uploadPath}/${await cid}/foo`, '_foo_');
      expect(fs.writeFile).toHaveBeenCalledWith(`${uploadPath}/${await cid}/bar`, '_bar_');
      expect(fs.writeFile).toHaveBeenCalledWith(`${uploadPath}/${await cid}.zip`, buffer);
    });

    it('skips an existing package', async () => {
      fs.access.mockReturnValue(Promise.resolve());
      fs.readlink.mockReturnValue(Promise.resolve(`${uploadPath}/${await cid}`));

      await expect(service.store(buffer)).resolves.toEqual(await cid);

      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(fs.rename).not.toHaveBeenCalled();
      expect(fs.symlink).not.toHaveBeenCalled();
    });
  });
});
