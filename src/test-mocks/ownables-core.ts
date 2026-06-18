import { createHash } from 'node:crypto';

export interface OwnablePackageCidEntry {
  path: string;
  content: Uint8Array;
}

export async function calculateOwnablePackageCid(entries: OwnablePackageCidEntry[]): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (entry.path === 'chain.json' || entry.path === 'timestamp.txt') continue;
    hash.update(entry.path);
    hash.update(entry.content);
  }

  return `cid-${hash.digest('hex').slice(0, 16)}`;
}
