import { Inject, Injectable } from '@nestjs/common';
import { Bucket } from 'any-bucket';
import { OWNABLES_BUCKET } from './storage.tokens.js';

@Injectable()
export class ArchiveStorageService {
  private readonly root = 'archives';

  constructor(@Inject(OWNABLES_BUCKET) private readonly bucket: Bucket) {}

  packageZipKey(cid: string): string {
    return `${this.root}/packages/${cid}/${cid}.zip`;
  }

  packageAssetKey(cid: string, filename: string): string {
    return `${this.root}/packages/${cid}/${filename.replace(/^\/+/, '')}`;
  }

  chainKey(cid: string): string {
    return `${this.root}/chains/${cid}/eventChain.json`;
  }

  async storePackageArtifacts(cid: string, zipData: Uint8Array, files: Map<string, Buffer>): Promise<void> {
    await this.bucket.put(this.packageZipKey(cid), Buffer.from(zipData));
    await Promise.all(
      Array.from(files.entries()).map(async ([filename, content]) => {
        await this.bucket.put(this.packageAssetKey(cid, filename), content);
      }),
    );
  }

  async storeEventChain(cid: string, eventChainData: Uint8Array): Promise<void> {
    await this.bucket.put(this.chainKey(cid), Buffer.from(eventChainData));
  }

  async getPackageZip(cid: string): Promise<Buffer> {
    const data = await this.bucket.get(this.packageZipKey(cid));
    return Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
  }

  async getEventChain(cid: string): Promise<Buffer> {
    const data = await this.bucket.get(this.chainKey(cid));
    return Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
  }

  async hasPackage(cid: string): Promise<boolean> {
    try {
      await this.bucket.get(this.packageZipKey(cid));
      return true;
    } catch {
      return false;
    }
  }

  async hasEventChain(cid: string): Promise<boolean> {
    try {
      await this.bucket.get(this.chainKey(cid));
      return true;
    } catch {
      return false;
    }
  }
}
