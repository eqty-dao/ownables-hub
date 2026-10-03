import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const TEST_SIGNER_MNEMONIC = 'test test test test test test test test test test test junk';
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const MAX_OUTPUT_LENGTH = 20_000;

async function reservePort() {
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'expected an IPv4 test port');

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  return address.port;
}

function startHub(port) {
  const hub = {
    child: undefined,
    stdout: '',
    stderr: '',
    spawnError: undefined,
  };
  const appendOutput = (stream) => (chunk) => {
    hub[stream] = `${hub[stream]}${chunk}`.slice(-MAX_OUTPUT_LENGTH);
  };

  hub.child = spawn('yarn', ['start:prod'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      SIGNER_MNEMONIC: process.env.SIGNER_MNEMONIC || TEST_SIGNER_MNEMONIC,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub.child.stdout.on('data', appendOutput('stdout'));
  hub.child.stderr.on('data', appendOutput('stderr'));
  hub.child.once('error', (error) => {
    hub.spawnError = error;
  });

  return hub;
}

function failure(message, hub) {
  const stdout = hub.stdout || '<no Hub stdout captured>';
  const stderr = hub.stderr || '<no Hub stderr captured>';
  return new Error(`${message}\nHub stdout:\n${stdout}\nHub stderr:\n${stderr}`);
}

async function waitForReady(hub, port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (hub.spawnError) {
      throw failure(`Hub failed to start: ${hub.spawnError.message}`, hub);
    }
    if (hub.child.exitCode !== null || hub.child.signalCode !== null) {
      throw failure(`Hub exited before readiness (code ${hub.child.exitCode}, signal ${hub.child.signalCode})`, hub);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/info`, {
        signal: AbortSignal.timeout(POLL_INTERVAL_MS),
      });
      if (response.ok) return response;
    } catch {
      // The child is still booting. The bounded deadline below reports its output on failure.
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw failure(`Hub did not become ready within ${STARTUP_TIMEOUT_MS}ms`, hub);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function signalChild(child, signal) {
  if (!child.pid) return;

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

async function stopHub(hub) {
  const { child } = hub;
  if (child.exitCode !== null || child.signalCode !== null) return;

  signalChild(child, 'SIGTERM');
  if (await waitForExit(child, SHUTDOWN_TIMEOUT_MS)) return;

  signalChild(child, 'SIGKILL');
  if (!(await waitForExit(child, SHUTDOWN_TIMEOUT_MS))) {
    throw failure('Hub child process did not exit after SIGKILL', hub);
  }
}

test('GET /info reports application metadata from the compiled Hub', { timeout: STARTUP_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 2 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for the compiled Hub E2E test');

  const port = await reservePort();
  const hub = startHub(port);
  t.after(async () => {
    await stopHub(hub);
  });

  const response = await waitForReady(hub, port);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.name, '@ownables/hub');
  assert.notEqual(body.env, undefined);
});
