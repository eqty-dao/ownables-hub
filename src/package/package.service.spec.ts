import { Test, TestingModule } from '@nestjs/testing';
import { expect, jest } from '@jest/globals';
import { PackageService } from './package.service';
import { ConfigModule } from '../common/config/config.module';
import * as fsModule from 'fs/promises';
import JSZip from 'jszip';
import { createHash } from 'crypto';

const fs = jest.mocked(fsModule);
jest.mock('fs/promises');

const cidHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

describe('PackageService', () => {
  let service: PackageService;
  const ipfs = {
    addAll: jest.fn(async function* (items: { content: string; path: string }[]) {
      for (const item of items) {
        yield {
          cid: { toString: () => `cid-${cidHash(item.content)}` },
          path: item.path,
          mode: 0o755,
        };
      }

      const dirContent = items.map((item) => item.content).join('');
      const dirCid = `cid-${cidHash(dirContent)}`;
      yield {
        cid: { toString: () => dirCid },
        path: dirCid,
        mode: 0o755,
      };
    }),
  };
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
      providers: [PackageService, { provide: 'IPFS', useValue: ipfs }, { provide: JSZip, useValue: zip }],
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
      expect(fs.access).toBeCalledWith('storage/packages/some_cid');
    });

    it('returns false if package does not exist', async () => {
      fs.access.mockReturnValue(Promise.reject(''));

      expect(await service.exists('some_cid')).toEqual(false);
      expect(fs.access).toBeCalledWith('storage/packages/some_cid');
    });
  });

  describe('file()', () => {
    it('gives the path to a file in a package', () => {
      const file = service.file('some_cid', 'index.html');
      expect(file).toEqual('storage/packages/some_cid/index.html');
    });
  });

  describe('store()', () => {
    const buffer = new Uint8Array([1, 2, 3]);
    const cid = `cid-${cidHash('{}_foo__bar_')}`;
    const uploadPath = 'storage/packages';

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

      expect(await service.store(buffer)).toEqual(cid);

      expect(zip.loadAsync).toBeCalledWith(buffer, { createFolders: true });
      expect(fs.writeFile).toBeCalledTimes(4);
      expect(fs.writeFile).toBeCalledWith(`${uploadPath}/${cid}/package.json`, '{}');
      expect(fs.writeFile).toBeCalledWith(`${uploadPath}/${cid}/foo`, '_foo_');
      expect(fs.writeFile).toBeCalledWith(`${uploadPath}/${cid}/bar`, '_bar_');
      expect(fs.writeFile).toBeCalledWith(`${uploadPath}/${cid}.zip`, buffer);
    });

    it('skips an existing package', async () => {
      fs.access.mockReturnValue(Promise.resolve());
      fs.readlink.mockReturnValue(Promise.resolve(`storage/packages/${cid}`));

      expect(await service.store(buffer)).toEqual(cid);

      expect(fs.writeFile).not.toBeCalled();
      expect(fs.rename).not.toBeCalled();
      expect(fs.symlink).not.toBeCalled();
    });
  });
});
