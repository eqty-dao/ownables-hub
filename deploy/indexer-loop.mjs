import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readActiveBaseConfig } from './base-config.mjs';

const { startBlockVariable } = readActiveBaseConfig();
const startBlock = process.env[startBlockVariable];
if (!/^\d+$/.test(startBlock ?? '') || BigInt(startBlock) === 0n) {
  throw new Error(`${startBlockVariable} must be a positive initialized Base block`);
}

const interval = Number(process.env.INDEXER_INTERVAL_SECONDS ?? 15);
if (!Number.isInteger(interval) || interval < 1 || interval > 86400) {
  throw new Error('INDEXER_INTERVAL_SECONDS must be an integer between 1 and 86400');
}

const stop = new AbortController();
let child;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stop.abort();
    child?.kill(signal);
  });
}

while (!stop.signal.aborted) {
  child = spawn(process.execPath, ['dist/indexer/main.js', '--active-slot'], { stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit');
  child = undefined;
  if (stop.signal.aborted) break;
  if (code !== 0) throw new Error(`Indexer exited with ${signal ?? code}`);

  try {
    await delay(interval * 1000, undefined, { signal: stop.signal });
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  }
}
