import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { Event, EventChain } from 'eqty-core';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const mainEntrypoint = join(projectRoot, 'dist', 'main.js');
const EXPECTED_ERROR =
  "Invalid package: unsupported Ownable runtime in 'ownable_bg.wasm'. Expected raw-ABI exports with no wasm imports; found unsupported imports from module(s): wbg";
const TEST_SIGNER_MNEMONIC = 'test test test test test test test test test test test junk';
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const MAX_OUTPUT_LENGTH = 20_000;

async function buildChain(wallet) {
  const chain = EventChain.create(wallet.address, 84532);
  const event = new Event({
    '@context': 'instantiate_msg.json',
    nft: {
      network: 'eip155:base',
      address: '0xabc0000000000000000000000000000000000001',
      id: '1',
    },
  });

  await event.addTo(chain).signWith({
    getAddress: async () => wallet.address,
    signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value),
  });

  return chain;
}

async function buildUnsupportedUploadArchive() {
  const fixtureDir = join(projectRoot, 'src', 'cosmwasm', '_test');
  const [ownableJs, ownableWasm] = await Promise.all([
    readFile(join(fixtureDir, 'ownable.js')),
    readFile(join(fixtureDir, 'ownable_bg.wasm')),
  ]);

  const moduleImports = WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(ownableWasm))).map(
    ({ module, name }) => ({ module, name }),
  );

  const wallet = ethers.Wallet.createRandom();
  const chain = await buildChain(wallet);
  const zip = new JSZip();
  zip.file('package.json', JSON.stringify({ name: 'fixture-ownable' }));
  zip.file('ownable.js', ownableJs);
  zip.file('ownable_bg.wasm', ownableWasm);
  zip.file('chain.json', JSON.stringify(chain.toJSON()));

  return {
    archive: await zip.generateAsync({ type: 'uint8array' }),
    moduleImports,
  };
}

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

function startHub(port, storageRoot) {
  const hub = {
    child: undefined,
    stdout: '',
    stderr: '',
    spawnError: undefined,
  };
  const appendOutput = (stream) => (chunk) => {
    hub[stream] = `${hub[stream]}${chunk}`.slice(-MAX_OUTPUT_LENGTH);
  };

  hub.child = spawn(process.execPath, [mainEntrypoint], {
    cwd: projectRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      OWNABLES_STORAGE: pathToFileURL(storageRoot).href,
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
  if (!hub) return new Error(message);

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
      if (response.ok) return;
    } catch {
      // The child is still booting. The bounded deadline reports its output on failure.
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

async function listStoredFiles(storageRoot) {
  try {
    const entries = await readdir(storageRoot, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function main() {
  assert.ok(process.versions.node.startsWith('24.'), 'Node 24 is required');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for the compiled Hub replay-boundary proof');
  await access(mainEntrypoint);

  const { archive, moduleImports } = await buildUnsupportedUploadArchive();
  assert.ok(moduleImports.length > 0, 'Expected unsupported fixture to require wasm imports');
  assert.ok(moduleImports.some(({ module }) => module === 'wbg'), 'Expected fixture imports from unsupported wbg module');

  const storageRoot = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'ownables-hub-replay-'));
  let hub;
  let primaryError;
  let cleanupError;
  let result;

  try {
    const port = await reservePort();
    hub = startHub(port, storageRoot);
    await waitForReady(hub, port);

    const form = new FormData();
    form.set('file', new Blob([archive], { type: 'application/zip' }), 'unsupported-runtime-ownable.zip');
    const response = await fetch(`http://127.0.0.1:${port}/ownables/upload`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
    });
    const responseBody = await response.text();
    assert.equal(response.status, 400, 'Expected unsupported runtime upload to return HTTP 400');
    assert.equal(responseBody, EXPECTED_ERROR, 'Expected the exact unsupported runtime response body');

    const storedFiles = await listStoredFiles(storageRoot);
    assert.equal(storedFiles.length, 0, 'Invalid runtime uploads must not write archive files');

    result = {
      verifiedBoundary: 'unsupported-runtime-upload-classification',
      statusCode: response.status,
      errorMessage: responseBody,
      importModules: Array.from(new Set(moduleImports.map(({ module }) => module))).sort(),
      importCount: moduleImports.length,
    };
  } catch (error) {
    primaryError = error;
  }

  try {
    if (hub) await stopHub(hub);
  } catch (error) {
    cleanupError = error;
  }

  try {
    await rm(storageRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }

  if (primaryError) throw failure(primaryError.message, hub);
  if (cleanupError) throw failure(cleanupError.message, hub);

  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
