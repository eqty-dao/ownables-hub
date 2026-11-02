import { Inject, Injectable } from '@nestjs/common';
import { Bucket } from 'any-bucket';
import { OWNABLES_BUCKET } from './storage.tokens';

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

  chainKey(ownableId: string): string {
    return `${this.root}/chains/${ownableId}/eventChain.json`;
  }

  immutableChainKey(ownableId: string, chainDigest: string): string {
    return `${this.root}/chains/${ownableId}/${chainDigest}.json`;
  }

  async storePackageArtifacts(cid: string, zipData: Uint8Array, files: Map<string, Buffer>): Promise<void> {
    await this.bucket.put(this.packageZipKey(cid), Buffer.from(zipData));
    await Promise.all(
      Array.from(files.entries()).map(async ([filename, content]) => {
        await this.bucket.put(this.packageAssetKey(cid, filename), content);
      }),
    );
  }

  async storeEventChain(ownableId: string, eventChainData: Uint8Array): Promise<void> {
    await this.bucket.put(this.chainKey(ownableId), Buffer.from(eventChainData));
  }

  async storeImmutableEventChain(ownableId: string, chainDigest: string, eventChainData: Uint8Array): Promise<string> {
    const key = this.immutableChainKey(ownableId, chainDigest);
    if (!(await this.bucket.has(key))) await this.bucket.put(key, Buffer.from(eventChainData));
    return key;
  }

  async getPackageZip(cid: string): Promise<Buffer> {
    const data = await this.bucket.get(this.packageZipKey(cid));
    return Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
  }

  async getEventChain(ownableId: string, legacyPackageCid?: string, chainStorageKey?: string | null): Promise<Buffer> {
    try {
      const data = await this.bucket.get(chainStorageKey ?? this.chainKey(ownableId));
      return Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
    } catch (error) {
      if (!legacyPackageCid || legacyPackageCid === ownableId) throw error;
      const data = await this.bucket.get(this.chainKey(legacyPackageCid));
      return Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
    }
  }

  async probe(): Promise<void> {
    await this.bucket.list();
  }

  async hasPackage(cid: string): Promise<boolean> {
    try {
      await this.bucket.get(this.packageZipKey(cid));
      return true;
    } catch {
      return false;
    }
  }

  async hasEventChain(ownableId: string, legacyPackageCid?: string, chainStorageKey?: string | null): Promise<boolean> {
    try {
      await this.getEventChain(ownableId, legacyPackageCid, chainStorageKey);
      return true;
    } catch {
      return false;
    }
  }
}
