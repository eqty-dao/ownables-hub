import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { chmodSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const mainSource = join(projectRoot, 'src', 'main.ts');
const dotEnv = join(projectRoot, '.env');
const TEST_SIGNER_MNEMONIC = 'test test test test test test test test test test test junk';
const STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 250;
const BOOTSTRAP_MESSAGE = 'Nest application successfully started';
const WEBPACK_SUCCESS = /webpack.*compiled successfully/gi;
const execFileAsync = promisify(execFile);

let sourceSnapshot;
let storageRoot;
let hub;
let cleanupPromise;

function output(hubProcess) {
  return `${hubProcess.stdout}${hubProcess.stderr}`;
}

function failure(message, hubProcess = hub) {
  if (!hubProcess) return new Error(message);

  return new Error(
    `${message}\nHub stdout:\n${hubProcess.stdout || '<no Hub stdout captured>'}\nHub stderr:\n${hubProcess.stderr || '<no Hub stderr captured>'}`,
  );
}

function sourceMode(fileStat) {
  return fileStat.mode & 0o777;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'expected an IPv4 test port');
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function startHub(port) {
  const hubProcess = {
    child: undefined,
    stdout: '',
    stderr: '',
    spawnError: undefined,
  };
  const append = (stream) => (chunk) => {
    const text = chunk.toString();
    hubProcess[stream] += text;
    process[stream].write(text);
  };

  hubProcess.child = spawn('yarn', ['start:dev'], {
    cwd: projectRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      OWNABLES_STORAGE: pathToFileURL(storageRoot).href,
      SIGNER_MNEMONIC: TEST_SIGNER_MNEMONIC,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hubProcess.child.stdout.on('data', append('stdout'));
  hubProcess.child.stderr.on('data', append('stderr'));
  hubProcess.child.once('error', (error) => {
    hubProcess.spawnError = error;
  });

  return hubProcess;
}

function assertHubRunning(hubProcess) {
  if (hubProcess.spawnError) {
    throw failure(`Hub failed to start: ${hubProcess.spawnError.message}`, hubProcess);
  }
  if (hubProcess.child.exitCode !== null || hubProcess.child.signalCode !== null) {
    throw failure(
      `Hub exited before the watch proof completed (code ${hubProcess.child.exitCode}, signal ${hubProcess.child.signalCode})`,
      hubProcess,
    );
  }
  if (output(hubProcess).includes('EMFILE')) {
    throw failure('Hub watch proof encountered EMFILE', hubProcess);
  }
}

function countMatches(text, expression) {
  return [...text.matchAll(expression)].length;
}

async function waitForCompilationAndBootstrap(hubProcess, expectedCount) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    assertHubRunning(hubProcess);
    const capturedOutput = output(hubProcess);
    const webpackCount = countMatches(capturedOutput, WEBPACK_SUCCESS);
    const bootstrapCount = countMatches(capturedOutput, new RegExp(BOOTSTRAP_MESSAGE, 'g'));

    if (webpackCount >= expectedCount && bootstrapCount >= expectedCount) {
      console.log(`Observed webpack compilation and Nest bootstrap ${expectedCount}.`);
      return;
    }
    await delay(RETRY_DELAY_MS);
  }

  throw failure(`Timed out waiting for webpack compilation and Nest bootstrap ${expectedCount}`, hubProcess);
}

async function waitForHealth(hubProcess, port, label) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    assertHubRunning(hubProcess);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(RETRY_DELAY_MS),
      });
      if (response.status === 200) {
        console.log(`${label} /health returned HTTP 200.`);
        return;
      }
    } catch {
      // The process is still booting. Captured output is included on timeout.
    }
    await delay(RETRY_DELAY_MS);
  }

  throw failure(`${label} /health did not return HTTP 200 within ${STARTUP_TIMEOUT_MS}ms`, hubProcess);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function stopHub() {
  if (!hub?.child || hub.child.exitCode !== null || hub.child.signalCode !== null) return;

  signalProcessGroup(hub.child, 'SIGTERM');
  if (!(await waitForExit(hub.child, SHUTDOWN_TIMEOUT_MS))) {
    signalProcessGroup(hub.child, 'SIGKILL');
    if (!(await waitForExit(hub.child, SHUTDOWN_TIMEOUT_MS))) {
      throw failure('Hub process group did not terminate after SIGKILL');
    }
  }
  console.log('Hub process group terminated.');
}

async function restoreSource() {
  if (!sourceSnapshot) return;
  await writeFile(mainSource, sourceSnapshot.bytes, { mode: sourceSnapshot.mode });
  await chmod(mainSource, sourceSnapshot.mode);
}

function restoreSourceSynchronously() {
  if (!sourceSnapshot) return;
  writeFileSync(mainSource, sourceSnapshot.bytes, { mode: sourceSnapshot.mode });
  chmodSync(mainSource, sourceSnapshot.mode);
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;

  cleanupPromise = (async () => {
    const errors = [];
    for (const operation of [
      restoreSource,
      stopHub,
      async () => {
        if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
      },
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Dev-watch proof cleanup failed');
  })();
  return cleanupPromise;
}

function handleSignal(signal) {
  try {
    restoreSourceSynchronously();
  } catch (error) {
    console.error(`Synchronous source restoration after ${signal} failed: ${error.message}`);
  }
  void cleanup()
    .catch((error) => {
      console.error(`Cleanup after ${signal} failed: ${error.message}`);
    })
    .finally(() => process.exit(1));
}

process.once('SIGINT', () => handleSignal('SIGINT'));
process.once('SIGTERM', () => handleSignal('SIGTERM'));
process.once('exit', () => {
  try {
    restoreSourceSynchronously();
  } catch (error) {
    console.error(`Synchronous source restoration on exit failed: ${error.message}`);
  }
});

async function assertCleanCheckout() {
  const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd: projectRoot });
  assert.equal(stdout, '', `Expected a clean checkout, found:\n${stdout}`);
}

async function assertSourceRestored() {
  const restoredBytes = await readFile(mainSource);
  const restoredMode = sourceMode(await stat(mainSource));
  assert.deepEqual(restoredBytes, sourceSnapshot.bytes, 'src/main.ts bytes were not restored');
  assert.equal(restoredMode, sourceSnapshot.mode, 'src/main.ts mode was not restored');
  console.log('Verified src/main.ts byte equality and mode restoration.');

  await execFileAsync('git', ['diff', '--exit-code', '--', 'src/main.ts'], { cwd: projectRoot });
  console.log('Verified git diff --exit-code -- src/main.ts.');
  await assertCleanCheckout();
  console.log('Verified final git status --short is clean.');
}

async function rejectRepositoryDotEnv() {
  try {
    await stat(dotEnv);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('verify:dev-watch requires no repository .env file');
}

async function main() {
  assert.ok(process.versions.node.startsWith('24.'), 'Node 24 is required');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for the dev-watch proof');
  await rejectRepositoryDotEnv();
  await assertCleanCheckout();

  sourceSnapshot = {
    bytes: await readFile(mainSource),
    mode: sourceMode(await stat(mainSource)),
  };
  storageRoot = await mkdtemp(join(tmpdir(), 'ownables-hub-dev-watch-'));

  try {
    const port = await reservePort();
    hub = startHub(port);
    await waitForCompilationAndBootstrap(hub, 1);
    await waitForHealth(hub, port, 'Initial');

    const marker = `// verify-dev-watch:${randomUUID()}`;
    await writeFile(mainSource, Buffer.concat([sourceSnapshot.bytes, Buffer.from(`\n${marker}\n`)]), {
      mode: sourceSnapshot.mode,
    });
    await chmod(mainSource, sourceSnapshot.mode);
    console.log(`Wrote unique temporary comment to src/main.ts: ${marker}`);

    await waitForCompilationAndBootstrap(hub, 2);
    await waitForHealth(hub, port, 'Post-edit');

    await restoreSource();
    console.log('Restored src/main.ts original bytes and mode.');
    await waitForCompilationAndBootstrap(hub, 3);
    await waitForHealth(hub, port, 'Final');
  } finally {
    await cleanup();
  }

  await assertSourceRestored();
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
