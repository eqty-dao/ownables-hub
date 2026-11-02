import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer, request as createHttpRequest } from 'node:http';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { AnchorValidationService, PublicEventReplayService } from '@ownables/core';
import { calculateOwnablePackageCid } from '@ownables/core/utils';
import { NodeRuntimeRpcProvider, NodeRuntimeSourceProvider } from '@ownables/platform-node';
import { Event, EventChain } from 'eqty-core';
import { ethers } from 'ethers';
import JSZip from 'jszip';
import { encode } from 'cbor-x';
import pg from 'pg';

const { Client } = pg;
const EXPECTED_UNSUPPORTED_RUNTIME_ERROR =
  "Invalid package: unsupported Ownable runtime in 'ownable_bg.wasm'. Expected raw-ABI exports with no wasm imports; found unsupported imports from module(s): wbg";
const TEST_SIGNER_MNEMONIC = 'test test test test test test test test test test test junk';
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const MAX_OUTPUT_LENGTH = 20_000;
const E2E_ANCHOR_CONTRACT = '0x0000000000000000000000000000000000000099';
const E2E_ANCHOR_TRANSACTION = `0x${'9'.repeat(64)}`;
const E2E_PUBLIC_EVENT_TRANSACTION = `0x${'8'.repeat(64)}`;
const STORY10_EXACT_UPLOAD_BYTES = 268435456;
const STORY10_TIMEOUT_MS = 180_000;
const STORY10_LIFECYCLE_ANCHOR = '0x0000000000000000000000000000000000000077';
const story10AnchorInterface = new ethers.Interface([
  'event Anchored(bytes32 indexed key, bytes32 value, address indexed sender, uint64 timestamp)',
]);

async function buildChain(wallet) {
  const chain = EventChain.create(wallet.address, 84532);
  const event = new Event({
    '@context': 'instantiate_msg.json',
    network_id: 84532,
  });

  await event.addTo(chain).signWith({
    getAddress: async () => wallet.address,
    signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value),
  });

  return chain;
}

async function buildUnsupportedUploadArchive() {
  const ownableWasm = buildWasmBindgenRuntimeWasm();

  const moduleImports = WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(ownableWasm))).map(
    ({ module, name }) => ({ module, name }),
  );

  const wallet = ethers.Wallet.createRandom();
  const chain = await buildChain(wallet);
  const zip = new JSZip();
  zip.file('package.json', JSON.stringify({ name: 'fixture-ownable' }));
  zip.file('ownable_bg.wasm', ownableWasm);
  zip.file('chain.json', JSON.stringify(chain.toJSON()));

  return {
    archive: await zip.generateAsync({ type: 'uint8array' }),
    moduleImports,
  };
}

function buildWasmBindgenRuntimeWasm() {
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01,
    0x04,
    0x01,
    0x60,
    0x00,
    0x00,
    0x02,
    0x09,
    0x01,
    0x03,
    0x77,
    0x62,
    0x67,
    0x01,
    0x78,
    0x00,
    0x00,
  ]);
}

function encodeUnsigned(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

function encodeSignedI64(value) {
  const bytes = [];
  let remaining = BigInt(value);
  while (true) {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    const isNegative = (byte & 0x40) !== 0;
    const done = (remaining === 0n && !isNegative) || (remaining === -1n && isNegative);
    if (!done) byte |= 0x80;
    bytes.push(byte);
    if (done) return bytes;
  }
}

function encodeString(value) {
  const bytes = Array.from(Buffer.from(value, 'utf8'));
  return [...encodeUnsigned(bytes.length), ...bytes];
}

function wasmSection(id, contents) {
  return [id, ...encodeUnsigned(contents.length), ...contents];
}

function packedPointerLength(pointer, length) {
  return (BigInt(length) << 32n) | BigInt(pointer);
}

function buildE2ERuntimeWasm(owner) {
  const actionEnvelope = encode({
    success: true,
    payload: encode({ result: encode({ attributes: [] }), mem: { state_dump: [] } }),
  });
  const queryEnvelope = encode({
    success: true,
    payload: encode({ result: Buffer.from(JSON.stringify({ owner }), 'utf8'), mem: { state_dump: [] } }),
  });
  const actionPointer = 1024;
  const queryPointer = 2048;
  const i64ResultBody = (pointer, length) => [
    0x00,
    0x42,
    ...encodeSignedI64(packedPointerLength(pointer, length)),
    0x0b,
  ];

  const typeSection = wasmSection(1, [
    ...encodeUnsigned(3),
    0x60,
    ...encodeUnsigned(1),
    0x7f,
    ...encodeUnsigned(1),
    0x7f,
    0x60,
    ...encodeUnsigned(2),
    0x7f,
    0x7f,
    ...encodeUnsigned(0),
    0x60,
    ...encodeUnsigned(2),
    0x7f,
    0x7f,
    ...encodeUnsigned(1),
    0x7e,
  ]);
  const functionSection = wasmSection(3, [
    ...encodeUnsigned(8),
    ...encodeUnsigned(0),
    ...encodeUnsigned(1),
    ...Array.from({ length: 6 }, () => encodeUnsigned(2)).flat(),
  ]);
  const memorySection = wasmSection(5, [...encodeUnsigned(1), 0x00, ...encodeUnsigned(1)]);
  const exportEntries = [
    ['memory', 0x02, 0],
    ['ownable_alloc', 0x00, 0],
    ['ownable_free', 0x00, 1],
    ['ownable_instantiate', 0x00, 2],
    ['ownable_execute', 0x00, 3],
    ['ownable_query', 0x00, 4],
    ['ownable_register', 0x00, 5],
    ['ownable_ingest', 0x00, 6],
    ['ownable_encode_public_event', 0x00, 7],
  ];
  const exportSection = wasmSection(7, [
    ...encodeUnsigned(exportEntries.length),
    ...exportEntries.flatMap(([name, kind, index]) => [...encodeString(name), kind, ...encodeUnsigned(index)]),
  ]);
  const functionBodies = [
    [0x00, 0x41, 0x00, 0x0b],
    [0x00, 0x0b],
    i64ResultBody(actionPointer, actionEnvelope.length),
    i64ResultBody(actionPointer, actionEnvelope.length),
    i64ResultBody(queryPointer, queryEnvelope.length),
    i64ResultBody(actionPointer, actionEnvelope.length),
    i64ResultBody(actionPointer, actionEnvelope.length),
    i64ResultBody(actionPointer, actionEnvelope.length),
  ];
  const codeSection = wasmSection(10, [
    ...encodeUnsigned(functionBodies.length),
    ...functionBodies.flatMap((body) => [...encodeUnsigned(body.length), ...body]),
  ]);
  const dataSegment = (pointer, data) => [
    0x00,
    0x41,
    ...encodeUnsigned(pointer),
    0x0b,
    ...encodeUnsigned(data.length),
    ...data,
  ];
  const dataSection = wasmSection(11, [
    ...encodeUnsigned(2),
    ...dataSegment(actionPointer, actionEnvelope),
    ...dataSegment(queryPointer, queryEnvelope),
  ]);

  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...typeSection,
    ...functionSection,
    ...memorySection,
    ...exportSection,
    ...codeSection,
    ...dataSection,
  ]);
}

async function buildSupportedUploadArchive() {
  const owner = ethers.Wallet.createRandom();
  const chain = EventChain.create(owner.address, 84532);
  const event = new Event({
    '@context': 'instantiate_msg.json',
    ownable_id: chain.id,
    package: 'compiled-route-fixture',
    network_id: 84532,
    keywords: [],
  });
  await event.addTo(chain).signWith({
    getAddress: async () => owner.address,
    signTypedData: (domain, types, value) => owner.signTypedData(domain, types, value),
  });

  const archive = new JSZip();
  archive.file('package.json', JSON.stringify({ name: 'compiled-route-fixture', title: 'Compiled route fixture' }));
  archive.file('chain.json', JSON.stringify(chain.toJSON()));
  archive.file('ownable_bg.wasm', buildE2ERuntimeWasm(owner.address));

  return {
    archive: await archive.generateAsync({ type: 'uint8array' }),
    chain,
    owner,
  };
}

async function buildStory10ExactLimitArchive() {
  const supported = await buildSupportedUploadArchive();
  const archive = new JSZip();
  archive.file('package.json', JSON.stringify({ name: 'compiled-route-fixture', title: 'Compiled route fixture' }));
  archive.file('chain.json', JSON.stringify(supported.chain.toJSON()));
  archive.file('ownable_bg.wasm', buildE2ERuntimeWasm(supported.owner.address));
  archive.file('representative-attachment.bin', Buffer.alloc(1), { compression: 'STORE' });
  const oneByteArchive = await archive.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const attachmentBytes = STORY10_EXACT_UPLOAD_BYTES - (oneByteArchive.byteLength - 1);
  assert.ok(attachmentBytes > 0, 'Expected the Story #10 ZIP fixture to have room for its representative attachment');
  archive.file('representative-attachment.bin', Buffer.alloc(attachmentBytes), { compression: 'STORE' });
  const exactArchive = await archive.generateAsync({ type: 'uint8array', compression: 'STORE' });
  assert.equal(exactArchive.byteLength, STORY10_EXACT_UPLOAD_BYTES, 'Expected an exact 256 MiB multipart file');
  return { ...supported, archive: exactArchive };
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

function startHub(port, storageRoot, extraEnv = {}) {
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
      OWNABLES_STORAGE: pathToFileURL(storageRoot).href,
      QUARANTINE_STORAGE: pathToFileURL(join(storageRoot, 'quarantine')).href,
      UPLOAD_INGRESS_CONCURRENCY: '1',
      UPLOAD_RATE_LIMIT_WINDOW_SECONDS: '60',
      UPLOAD_RATE_LIMIT_MAX_REQUESTS: '8',
      UPLOAD_PROCESSING_CONCURRENCY: '1',
      UPLOAD_MAX_EXPANDED_PROCESSING_BYTES: '536870912',
      QUARANTINE_MAX_PENDING_OBJECTS: '4',
      QUARANTINE_MAX_PENDING_BYTES: '536870912',
      QUARANTINE_RETENTION_SECONDS: '86400',
      QUARANTINE_PROMOTION_BATCH_SIZE: '16',
      QUARANTINE_CLEANUP_BATCH_SIZE: '16',
      QUARANTINE_LEASE_SECONDS: '300',
      QUARANTINE_ORPHAN_GRACE_SECONDS: '60',
      SIGNER_MNEMONIC: process.env.SIGNER_MNEMONIC || TEST_SIGNER_MNEMONIC,
      ...extraEnv,
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

function startWalletRpcServer() {
  const server = createHttpServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const incoming = JSON.parse(raw);
    const requests = Array.isArray(incoming) ? incoming : [incoming];
    const replies = requests.map((message) => {
      const result =
        message.method === 'eth_chainId'
          ? '0x14a34'
          : message.method === 'eth_getBalance'
            ? '0x1158e460913d0000'
            : message.method === 'eth_call'
              ? `0x${'0'.repeat(64)}`
              : '0x';
      return { jsonrpc: '2.0', id: message.id, result };
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(Array.isArray(incoming) ? replies : replies[0]));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected an IPv4 RPC test server address'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function startIndexerRpcServer() {
  let anchorLogs = [];
  let head = 7;
  const server = createHttpServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const incoming = JSON.parse(raw);
    const requests = Array.isArray(incoming) ? incoming : [incoming];
    const replies = requests.map((message) => {
      let result;
      switch (message.method) {
        case 'eth_chainId': result = '0x14a34'; break;
        case 'eth_blockNumber': result = `0x${head.toString(16)}`; break;
        case 'eth_getLogs': {
          const filter = message.params[0];
          const from = Number(BigInt(filter.fromBlock));
          const to = Number(BigInt(filter.toBlock));
          result = anchorLogs.filter((log) => Number(BigInt(log.blockNumber)) >= from && Number(BigInt(log.blockNumber)) <= to);
          break;
        }
        case 'eth_getBalance': result = '0x1158e460913d0000'; break;
        case 'eth_call': result = `0x${'0'.repeat(64)}`; break;
        default: result = '0x';
      }
      return { jsonrpc: '2.0', id: message.id, result };
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(Array.isArray(incoming) ? replies : replies[0]));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Expected an IPv4 RPC port'));
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        setAnchors(chain, owner) {
          anchorLogs = [...chain.anchorMap.entries()].map(([index, anchor]) => {
            const encoded = story10AnchorInterface.encodeEventLog(story10AnchorInterface.getEvent('Anchored'), [
              anchor.key.hex, anchor.value.hex, owner.address, 7n,
            ]);
            return {
              address: STORY10_LIFECYCLE_ANCHOR,
              topics: encoded.topics,
              data: encoded.data,
              blockNumber: '0x7',
              blockHash: `0x${'7'.repeat(64)}`,
              transactionHash: `0x${'a'.repeat(63)}${index.toString(16)}`,
              transactionIndex: '0x0',
              logIndex: `0x${index.toString(16)}`,
            };
          });
        },
        setHead(value) { head = value; },
      });
    });
  });
}

function runCompiledIndexer(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'dist/indexer/main.js'], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), STARTUP_TIMEOUT_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Compiled indexer exited ${code ?? signal}\n${output}`));
      else resolve(output);
    });
  });
}

async function readSseEvent(response, expectedType) {
  assert.ok(response.body, 'Expected an SSE response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      assert.equal(done, false, `Expected SSE event '${expectedType}', received: ${JSON.stringify(received)}`);
      received += decoder.decode(value, { stream: true });

      const eventStart = received.indexOf(`event: ${expectedType}\n`);
      if (eventStart >= 0) {
        const eventEnd = received.indexOf('\n\n', eventStart);
        if (eventEnd >= 0) {
          return received.slice(eventStart, eventEnd + 2);
        }
      }
    }
  } finally {
    await reader.cancel();
  }
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

async function listStoredFiles(storageRoot) {
  try {
    const entries = await readdir(storageRoot, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function listStoredObjectStats(storageRoot) {
  let files;
  try {
    files = (await readdir(storageRoot, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  } catch (error) {
    if (error?.code === 'ENOENT') return { count: 0, bytes: 0 };
    throw error;
  }
  const sizes = await Promise.all(files.map(async (file) => (await stat(join(file.parentPath, file.name))).size));
  return { count: files.length, bytes: sizes.reduce((total, size) => total + size, 0) };
}

async function postMultipartStream(port, fileName, fileChunks, fileBytes, timeoutMs) {
  const boundary = `----ownables-story10-${Math.random().toString(16).slice(2)}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const response = await new Promise((resolve, reject) => {
    let responded = false;
    const request = createHttpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/ownables',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(prefix.length + fileBytes + suffix.length),
        },
        timeout: timeoutMs,
      },
      async (incoming) => {
        const body = [];
        for await (const chunk of incoming) body.push(Buffer.from(chunk));
        responded = true;
        resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(body).toString('utf8') });
      },
    );
    request.once('error', (error) => {
      if (!responded) reject(error);
    });
    request.once('timeout', () => request.destroy(new Error(`Multipart request exceeded ${timeoutMs}ms`)));
    request.write(prefix);
    (async () => {
      try {
        for await (const chunk of fileChunks) {
          if (!request.write(chunk)) await new Promise((resume) => request.once('drain', resume));
        }
        if (!request.destroyed) request.end(suffix);
      } catch (error) {
        request.destroy(error);
      }
    })();
  });
  return response;
}

function countStructuredLog(hub, event) {
  return hub.stdout
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record?.event === event);
}

test('core packages provide the supported compatibility surface', async () => {
  const cid = await calculateOwnablePackageCid([
    { path: 'package.json', content: Buffer.from('{"name":"compat"}') },
    { path: 'index.html', content: Buffer.from('<h1>compat</h1>') },
  ]);
  assert.equal(typeof cid, 'string');
  assert.ok(cid.length > 0, 'Expected @ownables/core/utils to compute a non-empty package CID');

  const services = [
    new AnchorValidationService(),
    new PublicEventReplayService(),
    new NodeRuntimeSourceProvider(),
    new NodeRuntimeRpcProvider(),
  ];
  assert.ok(services.every((service) => typeof service === 'object'), 'Expected supported services to construct');

  const wallet = ethers.Wallet.createRandom();
  const chain = EventChain.create(wallet.address, 84532);
  const event = new Event({
    '@context': 'instantiate_msg.json',
    network_id: 84532,
  });

  await event.addTo(chain).signWith({
    getAddress: async () => wallet.address,
    signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value),
  });

  assert.ok(event.signature, 'Expected eqty-core EventChain event to be signed');
  assert.ok(event.signerAddress, 'Expected eqty-core EventChain event signer');
  assert.equal(chain.events.length, 1, 'Expected one eqty-core EventChain event');
});

test('GET /info reports application metadata from the compiled Hub', { timeout: STARTUP_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 2 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for the compiled Hub E2E test');

  const { archive, moduleImports } = await buildUnsupportedUploadArchive();
  const { archive: supportedArchive, chain, owner } = await buildSupportedUploadArchive();
  assert.ok(moduleImports.length > 0, 'Expected unsupported fixture to require wasm imports');
  assert.ok(moduleImports.some(({ module }) => module === 'wbg'), 'Expected fixture imports from unsupported wbg module');

  const database = new Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  const chainId = '84532';
  const subjectId = ethers.keccak256(ethers.getBytes(chain.id)).toLowerCase();
  const ownerAccount = `eip155:${chainId}:${owner.address.toLowerCase()}`;
  t.after(async () => {
    try {
      await database.query(`DELETE FROM indexed_public_events WHERE transaction_hash = LOWER($1)`, [E2E_PUBLIC_EVENT_TRANSACTION]);
      await database.query(`DELETE FROM indexed_anchor_events WHERE transaction_hash = LOWER($1)`, [E2E_ANCHOR_TRANSACTION]);
      await database.query(`DELETE FROM ownable_records WHERE subject_id = LOWER($1)`, [subjectId]);
    } finally {
      await database.end();
    }
  });

  for (const [index, anchor] of chain.anchorMap.entries()) {
    await database.query(
      `INSERT INTO indexed_anchor_events (
         slot_name, chain_id, anchor_contract_address, block_number, block_hash,
         transaction_hash, transaction_index, log_index, event_name, package_cid,
         owner_address, payload_json
       ) VALUES ($1, $2, LOWER($3), $4, LOWER($5), LOWER($6), $7, $8, $9, NULL, LOWER($10), $11::jsonb)`,
      [
        'testnet',
        chainId,
        E2E_ANCHOR_CONTRACT,
        '7',
        `0x${'7'.repeat(64)}`,
        E2E_ANCHOR_TRANSACTION,
        0,
        index,
        'Anchored',
        owner.address,
        JSON.stringify({ key: anchor.key.hex, value: anchor.value.hex }),
      ],
    );
  }

  const rpc = await startWalletRpcServer();
  t.after(() => new Promise((resolve, reject) => rpc.server.close((error) => (error ? reject(error) : resolve()))));

  const port = await reservePort();
  const storageRoot = await mkdtemp(join(tmpdir(), 'ownables-hub-e2e-'));
  const hub = startHub(port, storageRoot, {
    LOCAL_DEV_RECIPIENT_DISCOVERY_ENABLED: 'true',
    HUB_NETWORK_PROFILE: 'testnet',
    TESTNET_CHAIN_ID: chainId,
    TESTNET_RPC_URL: rpc.url,
    TESTNET_BASE_RPC_URL: rpc.url,
    TESTNET_ANCHOR_CONTRACT_ADDR: E2E_ANCHOR_CONTRACT,
    TESTNET_ANCHOR_START_BLOCK: '0',
    MAINNET_CHAIN_ID: '8453',
    MAINNET_RPC_URL: rpc.url,
    MAINNET_ANCHOR_CONTRACT_ADDR: '0x0000000000000000000000000000000000000098',
    MAINNET_ANCHOR_START_BLOCK: '0',
  });
  t.after(async () => {
    try {
      await stopHub(hub);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  const response = await waitForReady(hub, port);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.name, '@ownables/hub');
  assert.notEqual(body.env, undefined);

  const healthResponse = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
  });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, 'ok');

  const openApiResponse = await fetch(`http://127.0.0.1:${port}/api-docs-json`, {
    signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
  });
  assert.equal(openApiResponse.status, 200);
  const openApi = await openApiResponse.json();
  for (const path of [
    '/',
    '/info',
    '/health',
    '/api/v1/auth/nonce',
    '/api/v1/auth/verify',
    '/ownables',
    '/ownables/{id}/bundle',
    '/ownables/{id}/verification',
    '/ownables/{id}/public-events',
    '/accounts/{account}/available-ownables',
    '/accounts/{account}/available-ownables/events',
    '/public-events',
    '/hub/wallet/{network}',
  ]) {
    assert.ok(openApi.paths[path], `Expected canonical OpenAPI path ${path}`);
  }
  for (const path of [
    '/packages',
    '/packages/{cid}/download',
    '/ownables/upload',
    '/ownables/{id}/chain',
    '/ownables/available',
    '/ownables/available/stream',
    '/ownables/public-events/stream',
    '/ownables/serverinfo',
    '/ownables/bridge',
    '/ownables/bridged',
    '/ownables/chains',
    '/ownables/isUnlockProofValid',
    '/ownables/example/unlock-proof',
  ]) {
    assert.equal(openApi.paths[path], undefined, `Expected removed OpenAPI path ${path} to be absent`);
  }

  const accountEventController = new AbortController();
  const accountEventResponse = fetch(
    `http://127.0.0.1:${port}/accounts/${encodeURIComponent(ownerAccount)}/available-ownables/events`,
    { signal: accountEventController.signal },
  );
  await delay(POLL_INTERVAL_MS);

  const supportedForm = new FormData();
  supportedForm.set('file', new Blob([supportedArchive], { type: 'application/zip' }), 'supported-ownable.zip');
  const supportedUploadResponse = await fetch(`http://127.0.0.1:${port}/ownables`, {
    method: 'POST',
    body: supportedForm,
    signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
  });
  assert.equal(supportedUploadResponse.status, 201, 'Expected the canonical upload to create an Ownable');
  const supportedUpload = await supportedUploadResponse.json();
  assert.equal(supportedUpload.ownableId, chain.id);
  assert.equal(Object.hasOwn(supportedUpload, 'nftNetwork'), false);
  assert.equal(Object.hasOwn(supportedUpload, 'smartContractAddress'), false);
  assert.equal(Object.hasOwn(supportedUpload, 'NftId'), false);
  assert.equal(supportedUploadResponse.headers.get('location'), `/ownables/${encodeURIComponent(chain.id)}`);

  const verificationResponse = await fetch(
    `http://127.0.0.1:${port}/ownables/${encodeURIComponent(chain.id)}/verification`,
    { signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) },
  );
  assert.equal(verificationResponse.status, 200, 'Expected the canonical verification response');
  const verification = await verificationResponse.json();
  assert.equal(Object.hasOwn(verification, 'nft'), false);

  const storedFilesBeforeInvalidUpload = (await listStoredFiles(storageRoot)).sort();
  assert.ok(storedFilesBeforeInvalidUpload.length > 0, 'Expected the successful upload to persist bundle files');

  const accountEvent = await accountEventResponse;
  const accountEventChunk = await readSseEvent(accountEvent, 'available-ownable');
  accountEventController.abort();
  assert.match(accountEventChunk, /^event: available-ownable/m);
  assert.match(accountEventChunk, new RegExp(`"owner":"${ownerAccount}"`));
  assert.match(accountEventChunk, new RegExp(`"id":"${chain.id}"`));

  const accountResponse = await fetch(
    `http://127.0.0.1:${port}/accounts/${encodeURIComponent(ownerAccount)}/available-ownables`,
    { signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) },
  );
  assert.equal(accountResponse.status, 200);
  const account = await accountResponse.json();
  assert.equal(account.owner, ownerAccount);
  assert.deepEqual(account.entries.map((entry) => entry.id), [chain.id]);

  await database.query(
    `INSERT INTO indexed_public_events (
       slot_name, chain_id, anchor_contract_address, block_number, block_hash,
       transaction_hash, transaction_index, log_index, event_name, ownable_id,
       package_cid, subject_id, source_address, event_type, data_hex, event_timestamp, payload_json
     ) VALUES (
       $1, $2, LOWER($3), $4, LOWER($5), LOWER($6), $7, $8, $9,
       (SELECT id FROM ownable_records WHERE subject_id = LOWER($10) LIMIT 1),
       (SELECT package_cid FROM ownable_records WHERE subject_id = LOWER($10) LIMIT 1),
       LOWER($10), LOWER($11), $12, LOWER($13), $14, $15::jsonb
     )`,
    [
      'testnet',
      chainId,
      E2E_ANCHOR_CONTRACT,
      '7',
      `0x${'6'.repeat(64)}`,
      E2E_PUBLIC_EVENT_TRANSACTION,
      0,
      0,
      'PublicEvent',
      subjectId,
      '0x00000000000000000000000000000000000000bb',
      'compiled-route-event',
      '0x1234',
      '7',
      JSON.stringify({ source: 'compiled-e2e' }),
    ],
  );

  const defaultPublicEvents = await fetch(
    `http://127.0.0.1:${port}/public-events?ownableId=${encodeURIComponent(chain.id)}&ownableId=${encodeURIComponent(chain.id)}`,
    { signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) },
  );
  assert.equal(defaultPublicEvents.status, 200);
  const defaultPublicEventChunk = await readSseEvent(defaultPublicEvents, 'public-event');
  assert.match(defaultPublicEventChunk, /^event: public-event/m);
  assert.match(defaultPublicEventChunk, /"eventType":"compiled-route-event"/);
  assert.match(defaultPublicEventChunk, new RegExp(`"ownableId":"${chain.id}"`));

  const explicitPublicEvents = await fetch(
    `http://127.0.0.1:${port}/public-events?ownableId=${encodeURIComponent(chain.id)}&fromBlock=7`,
    { signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) },
  );
  assert.equal(explicitPublicEvents.status, 200);
  const explicitPublicEventChunk = await readSseEvent(explicitPublicEvents, 'public-event');
  assert.match(explicitPublicEventChunk, /"eventType":"compiled-route-event"/);

  for (const path of ['/public-events', `/public-events?ownableId=${encodeURIComponent(chain.id)}&fromBlock=-1`]) {
    const invalidPublicEvents = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
    });
    assert.equal(invalidPublicEvents.status, 400, `Expected ${path} to reject before subscribing`);
  }

  const walletResponse = await fetch(`http://127.0.0.1:${port}/hub/wallet/eip155:base`, {
    signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
  });
  assert.equal(walletResponse.status, 200);
  const wallet = await walletResponse.json();
  assert.deepEqual(wallet, {
    address: ethers.Wallet.fromPhrase(TEST_SIGNER_MNEMONIC).address,
    networkId: 'eip155:84532',
    balance: '1.25',
    unit: 'ETH',
  });
  assert.equal(Object.hasOwn(wallet, 'privateKey'), false);
  const unsupportedWalletResponse = await fetch(`http://127.0.0.1:${port}/hub/wallet/eip155:unknown`, {
    signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
  });
  assert.equal(unsupportedWalletResponse.status, 400);

  const form = new FormData();
  form.set('file', new Blob([archive], { type: 'application/zip' }), 'unsupported-runtime-ownable.zip');
  const uploadResponse = await fetch(`http://127.0.0.1:${port}/ownables`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
  });
  const uploadResponseBody = await uploadResponse.text();
  assert.equal(uploadResponse.status, 400, 'Expected unsupported runtime upload to return HTTP 400');
  assert.equal(uploadResponseBody, EXPECTED_UNSUPPORTED_RUNTIME_ERROR, 'Expected the exact unsupported runtime response body');

  const storedFiles = (await listStoredFiles(storageRoot)).sort();
  assert.deepEqual(storedFiles, storedFilesBeforeInvalidUpload, 'Invalid runtime uploads must not write archive files');

  for (const path of [
    '/ownables/upload',
    '/ownables/available',
    '/ownables/available/stream',
    '/ownables/public-events/stream',
    '/ownables/serverinfo',
    '/ownables/bridge',
    '/ownables/bridged',
    '/ownables/chains',
    '/ownables/isUnlockProofValid',
    '/ownables/fixture/chain',
    '/ownables/fixture/unlock-proof',
    '/packages',
    '/packages/fixture/download',
  ]) {
    const removedResponse = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
    });
    assert.equal(removedResponse.status, 404, `Expected removed route ${path} to return 404`);
  }
});

test('story10 compiled Hub and indexer promote a durable pending upload across processes', { timeout: 120_000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for the compiled Hub E2E test');
  const { archive, chain, owner } = await buildSupportedUploadArchive();
  const subjectId = ethers.keccak256(ethers.getBytes(chain.id)).toLowerCase();
  let expiringSubject = null;
  const account = `eip155:84532:${owner.address.toLowerCase()}`;
  const database = new Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  await database.query(
    `DELETE FROM indexed_anchor_events WHERE slot_name = 'testnet' AND anchor_contract_address = LOWER($1)`,
    [STORY10_LIFECYCLE_ANCHOR],
  );
  await database.query(
    `DELETE FROM indexer_cursors WHERE slot_name = 'testnet' AND anchor_contract_address = LOWER($1)`,
    [STORY10_LIFECYCLE_ANCHOR],
  );
  t.after(async () => {
    try {
      await database.query('DELETE FROM quarantined_ownable_uploads WHERE subject_id = LOWER($1)', [subjectId]);
      if (expiringSubject) await database.query('DELETE FROM quarantined_ownable_uploads WHERE subject_id = LOWER($1)', [expiringSubject]);
      await database.query('DELETE FROM ownable_records WHERE subject_id = LOWER($1)', [subjectId]);
      await database.query(
        `DELETE FROM indexed_anchor_events WHERE slot_name = 'testnet' AND anchor_contract_address = LOWER($1)`,
        [STORY10_LIFECYCLE_ANCHOR],
      );
      await database.query(
        `DELETE FROM indexer_cursors WHERE slot_name = 'testnet' AND anchor_contract_address = LOWER($1)`,
        [STORY10_LIFECYCLE_ANCHOR],
      );
    } finally {
      await database.end();
    }
  });

  const rpc = await startIndexerRpcServer();
  t.after(() => new Promise((resolve, reject) => rpc.server.close((error) => (error ? reject(error) : resolve()))));
  const storageRoot = await mkdtemp(join(tmpdir(), 'ownables-hub-story10-lifecycle-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const env = {
    LOCAL_DEV_RECIPIENT_DISCOVERY_ENABLED: 'true',
    HUB_NETWORK_PROFILE: 'testnet',
    TESTNET_CHAIN_ID: '84532',
    TESTNET_RPC_URL: rpc.url,
    TESTNET_BASE_RPC_URL: rpc.url,
    TESTNET_ANCHOR_CONTRACT_ADDR: STORY10_LIFECYCLE_ANCHOR,
    TESTNET_ANCHOR_START_BLOCK: '0',
    MAINNET_CHAIN_ID: '8453',
    MAINNET_RPC_URL: rpc.url,
    MAINNET_ANCHOR_CONTRACT_ADDR: '0x0000000000000000000000000000000000000098',
    MAINNET_ANCHOR_START_BLOCK: '0',
    OWNABLES_STORAGE: pathToFileURL(storageRoot).href,
    QUARANTINE_STORAGE: pathToFileURL(join(storageRoot, 'quarantine')).href,
    QUARANTINE_MAX_PENDING_OBJECTS: '4',
    QUARANTINE_MAX_PENDING_BYTES: '536870912',
    UPLOAD_RATE_LIMIT_MAX_REQUESTS: '1000',
    SIGNER_MNEMONIC: TEST_SIGNER_MNEMONIC,
  };
  const port = await reservePort();
  env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  let hub = startHub(port, storageRoot, env);
  t.after(async () => stopHub(hub));
  await waitForReady(hub, port);
  const baseUrl = `http://127.0.0.1:${port}`;
  async function upload(bytes = archive) {
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: 'application/zip' }), 'pending-ownable.zip');
    return fetch(`${baseUrl}/ownables`, { method: 'POST', body: form, signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) });
  }
  async function assertHidden() {
    const discovery = await fetch(`${baseUrl}/accounts/${encodeURIComponent(account)}/available-ownables`);
    assert.equal(discovery.status, 200);
    assert.deepEqual((await discovery.json()).entries, []);
    for (const suffix of ['bundle', 'verification']) {
      const response = await fetch(`${baseUrl}/ownables/${encodeURIComponent(chain.id)}/${suffix}`);
      assert.notEqual(response.status, 200, `Pending Ownable ${suffix} must remain private`);
    }
    const records = await database.query('SELECT COUNT(*)::int AS count FROM ownable_records WHERE subject_id = LOWER($1)', [subjectId]);
    assert.equal(records.rows[0].count, 0, 'Pending uploads must not create an accepted Ownable row');
  }

  const first = await upload();
  assert.equal(first.status, 202);
  const pending = await first.json();
  assert.deepEqual(Object.keys(pending).sort(), ['expiresAt', 'ownableId', 'status']);
  assert.equal(pending.ownableId, chain.id);
  assert.equal(pending.status, 'pending');
  await assertHidden();
  const retry = await upload();
  assert.equal(retry.status, 202);
  assert.deepEqual(await retry.json(), pending, 'Identical retry must retain the original expiry');
  assert.equal((await listStoredFiles(join(storageRoot, 'quarantine'))).length, 1);

  await stopHub(hub);
  hub = startHub(port, storageRoot, env);
  await waitForReady(hub, port);
  assert.deepEqual(await (await upload()).json(), pending, 'Pending identity must survive a Hub restart');
  await assertHidden();

  const subscriber = new AbortController();
  t.after(() => subscriber.abort());
  const eventResponse = await fetch(`${baseUrl}/accounts/${encodeURIComponent(account)}/available-ownables/events`, {
    signal: subscriber.signal,
  });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type') ?? '', /text\/event-stream/);
  rpc.setAnchors(chain, owner);
  await runCompiledIndexer(env);
  const event = await readSseEvent(eventResponse, 'available-ownable');
  subscriber.abort();
  assert.match(event, new RegExp(`"id":"${chain.id}"`));
  assert.match(event, new RegExp(`"owner":"${account}"`));

  const discovery = await fetch(`${baseUrl}/accounts/${encodeURIComponent(account)}/available-ownables`);
  assert.deepEqual((await discovery.json()).entries.map((entry) => entry.id), [chain.id]);
  const bundle = await fetch(`${baseUrl}/ownables/${encodeURIComponent(chain.id)}/bundle`);
  assert.equal(bundle.status, 200, 'Promoted Ownable must be downloadable');
  const zip = await JSZip.loadAsync(await bundle.arrayBuffer());
  assert.ok(zip.file('chain.json'));
  assert.ok(zip.file('ownable_bg.wasm'));
  const availableRetry = await upload();
  assert.equal(availableRetry.status, 200);
  assert.equal((await availableRetry.json()).status, 'available');
  await runCompiledIndexer(env);
  const published = await database.query('SELECT COUNT(*)::int AS count FROM ownable_records WHERE subject_id = LOWER($1)', [subjectId]);
  assert.equal(published.rows[0].count, 1, 'Repeated indexer runs must not duplicate publication');

  const expiring = await buildSupportedUploadArchive();
  expiringSubject = ethers.keccak256(ethers.getBytes(expiring.chain.id)).toLowerCase();
  const expiringResponse = await upload(expiring.archive);
  assert.equal(expiringResponse.status, 202);
  await database.query(
    `UPDATE quarantined_ownable_uploads SET expires_at = NOW() - INTERVAL '1 second' WHERE subject_id = LOWER($1)`,
    [expiringSubject],
  );
  await runCompiledIndexer(env);
  const expired = await database.query(
    `SELECT status, private_object_deleted_at IS NOT NULL AS deleted FROM quarantined_ownable_uploads WHERE subject_id = LOWER($1)`,
    [expiringSubject],
  );
  assert.deepEqual(expired.rows, [{ status: 'expired', deleted: true }], 'Expired private upload must be deleted');
  assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM ownable_records WHERE subject_id = LOWER($1)', [expiringSubject])).rows[0].count, 0);
  const expiredBundle = await fetch(`${baseUrl}/ownables/${encodeURIComponent(expiring.chain.id)}/bundle`);
  assert.notEqual(expiredBundle.status, 200);
});

test('story10-256mib quarantines the exact ingress limit and rejects one byte more before replay', { timeout: STORY10_TIMEOUT_MS * 2 + SHUTDOWN_TIMEOUT_MS * 2 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for the compiled Hub E2E test');

  const { archive, chain } = await buildStory10ExactLimitArchive();
  const subjectId = ethers.keccak256(ethers.getBytes(chain.id)).toLowerCase();
  const database = new Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  t.after(async () => {
    try {
      await database.query('DELETE FROM quarantined_ownable_uploads WHERE subject_id = LOWER($1)', [subjectId]);
      await database.query('DELETE FROM ownable_records WHERE subject_id = LOWER($1)', [subjectId]);
    } finally {
      await database.end();
    }
  });

  const port = await reservePort();
  const storageRoot = await mkdtemp(join(tmpdir(), 'ownables-hub-story10-256mib-'));
  const hub = startHub(port, storageRoot, {
    STORY10_RESOURCE_PROFILE: 'story10-256mib',
    NODE_OPTIONS: '--max-old-space-size=2048',
    HUB_NETWORK_PROFILE: 'testnet',
    TESTNET_CHAIN_ID: '84532',
    TESTNET_RPC_URL: 'http://127.0.0.1:1',
    TESTNET_BASE_RPC_URL: 'http://127.0.0.1:1',
    TESTNET_ANCHOR_CONTRACT_ADDR: E2E_ANCHOR_CONTRACT,
    TESTNET_ANCHOR_START_BLOCK: '0',
    MAINNET_CHAIN_ID: '8453',
    MAINNET_RPC_URL: 'http://127.0.0.1:1',
    MAINNET_ANCHOR_CONTRACT_ADDR: '0x0000000000000000000000000000000000000098',
    MAINNET_ANCHOR_START_BLOCK: '0',
  });
  t.after(async () => {
    try {
      await stopHub(hub);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  await waitForReady(hub, port);
  const exactStartedAt = Date.now();
  const exactResponse = await postMultipartStream(port, 'exact-256mib.zip', [archive], archive.byteLength, STORY10_TIMEOUT_MS);
  const exactElapsedMilliseconds = Date.now() - exactStartedAt;
  assert.equal(exactResponse.status, 202, 'Expected the exact compressed ingress limit to quarantine pending evidence');
  const exactBody = JSON.parse(exactResponse.body);
  assert.deepEqual(Object.keys(exactBody).sort(), ['expiresAt', 'ownableId', 'status']);
  assert.equal(exactBody.status, 'pending');
  assert.equal(exactBody.ownableId, chain.id);
  assert.ok(exactElapsedMilliseconds <= STORY10_TIMEOUT_MS, 'Expected exact-limit upload within the Story timeout');

  const healthResponse = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(STORY10_TIMEOUT_MS) });
  assert.equal(healthResponse.status, 200, 'Expected Hub to remain alive after exact-limit upload');
  const pending = await database.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(compressed_bytes), 0)::text AS bytes
       FROM quarantined_ownable_uploads WHERE subject_id = LOWER($1) AND status = 'pending'`,
    [subjectId],
  );
  assert.deepEqual(pending.rows[0], { count: 1, bytes: String(STORY10_EXACT_UPLOAD_BYTES) });
  const privateObjects = await listStoredObjectStats(join(storageRoot, 'quarantine'));
  assert.deepEqual(privateObjects, { count: 1, bytes: STORY10_EXACT_UPLOAD_BYTES });

  async function* overLimitChunks() {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < 256; index += 1) yield chunk;
    yield Buffer.alloc(1);
  }
  const tooLargeStartedAt = Date.now();
  const tooLargeResponse = await postMultipartStream(
    port,
    'one-byte-too-large.zip',
    overLimitChunks(),
    STORY10_EXACT_UPLOAD_BYTES + 1,
    STORY10_TIMEOUT_MS,
  );
  assert.equal(tooLargeResponse.status, 413, 'Expected byte 268435457 to fail at multipart ingress');
  assert.ok(Date.now() - tooLargeStartedAt <= STORY10_TIMEOUT_MS, 'Expected oversized ingress rejection within the Story timeout');
  assert.equal((await database.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(compressed_bytes), 0)::text AS bytes
       FROM quarantined_ownable_uploads WHERE subject_id = LOWER($1) AND status = 'pending'`,
    [subjectId],
  )).rows[0].count, 1, 'Expected oversized upload to leave pending rows unchanged');
  assert.deepEqual(await listStoredObjectStats(join(storageRoot, 'quarantine')), privateObjects);

  const stagingRecords = countStructuredLog(hub, 'quarantine_staged');
  assert.equal(stagingRecords.length, 1, 'Expected oversized ingress to skip staging');
  const measurement = {
    profile: 'story10-256mib',
    compressedBytesReceived: archive.byteLength,
    actualExpandedBytes: stagingRecords[0]?.expandedBytes,
    elapsedMilliseconds: exactElapsedMilliseconds,
    maxRssBytes: stagingRecords[0]?.maxRssBytes,
    memoryUsage: stagingRecords[0]?.memoryUsage,
    response: { status: exactResponse.status, body: exactBody },
    pending: pending.rows[0],
    privateObjects,
    replayInvocationCount: (hub.stdout.match(/unzipping Zip files into memory/g) ?? []).length,
    stagingInvocationCount: stagingRecords.length,
  };
  assert.ok(measurement.actualExpandedBytes <= 536870912, 'Expected expanded bytes to remain within the processing lease');
  assert.ok(measurement.maxRssBytes <= 3221225472, 'Expected the Hub child RSS to remain below 3 GiB');
  assert.equal(measurement.replayInvocationCount, 1, 'Expected oversized ingress to skip replay');
  console.log(JSON.stringify({ event: 'story10_256mib_measurement', ...measurement }));
});
