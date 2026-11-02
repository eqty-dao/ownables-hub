import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Bucket } from 'any-bucket';
import { QUARANTINE_BUCKET } from './storage.tokens';

@Injectable()
export class QuarantineStorageService {
  constructor(@Inject(QUARANTINE_BUCKET) private readonly bucket: Bucket) {}

  keyForDigest(digest: string): string {
    return `quarantine/uploads/${digest}.zip`;
  }

  digest(contents: Uint8Array): string {
    return createHash('sha256').update(contents).digest('hex');
  }

  async store(digest: string, contents: Uint8Array): Promise<string> {
    const key = this.keyForDigest(digest);
    if (!(await this.bucket.has(key))) {
      await this.bucket.put(key, contents);
    }
    return key;
  }

  async read(key: string): Promise<Buffer> {
    const contents = await this.bucket.get(key);
    return Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  }

  async remove(key: string): Promise<void> {
    if (await this.bucket.has(key)) await this.bucket.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.bucket.has(key);
  }

  async probe(): Promise<void> {
    const key = `quarantine/probes/${randomUUID()}`;
    await this.bucket.put(key, Buffer.alloc(0));
    await this.bucket.delete(key);
  }
}
