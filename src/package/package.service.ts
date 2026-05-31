import { Injectable, OnModuleInit } from '@nestjs/common';
import { calculateOwnablePackageCid } from '@ownables/core';
import JSZip from 'jszip';
import { ArchiveStorageService } from '../storage/archive-storage.service.js';

@Injectable()
export class PackageService implements OnModuleInit {
  constructor(
    private readonly zip: JSZip,
    private readonly storage: ArchiveStorageService,
  ) {}

  async onModuleInit() {}

  private async unzip(data: Uint8Array): Promise<Map<string, Buffer>> {
    const archive = await this.zip.loadAsync(data, { createFolders: true });

    const entries: Array<[string, Buffer]> = await Promise.all(
      Object.entries(archive.files)
        .filter(([filename]) => filename !== 'chain.json')
        .map(async ([filename, file]) => [filename, await file.async('nodebuffer')]),
    );

    return new Map(entries);
  }

  private async getCid(files: Map<string, Buffer>): Promise<string> {
    return calculateOwnablePackageCid(Array.from(files.entries()).map(([filename, content]) => ({
      path: filename,
      content,
    })));
  }

  async store(data: Uint8Array): Promise<string> {
    const files = await this.unzip(data);
    if (!files.has('package.json')) throw new Error("Invalid package: 'package.json' is missing");

    const cid = await this.getCid(files);
    if (await this.exists(cid)) return cid;

    await this.storage.storePackageArtifacts(cid, data, files);

    return cid;
  }

  async exists(cid: string): Promise<boolean> {
    return await this.storage.hasPackage(cid);
  }

  file(cid: string, filename?: string): string {
    return filename ? this.storage.packageAssetKey(cid, filename) : this.storage.packageZipKey(cid);
  }

  async zipped(cid: string): Promise<JSZip> {
    const data = await this.storage.getPackageZip(cid);
    return await this.zip.loadAsync(data, { createFolders: true });
  }

  async hasMethod(cid: string, msgType: string, method: string): Promise<boolean> {
    const zipped = await this.zipped(cid);
    const file = zipped.file(`${msgType}_msg.json`);
    if (!file) {
      return false;
    }
    const json = await file.async('string');
    const schema = JSON.parse(json);

    return schema.oneOf.findIndex((m) => m.required.includes(method)) >= 0;
  }
}
