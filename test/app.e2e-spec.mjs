import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AnchorValidationService, PublicEventReplayService } from '@ownables/core';
import { calculateOwnablePackageCid } from '@ownables/core/utils';
import { NodeRuntimeRpcProvider, NodeRuntimeSourceProvider } from '@ownables/platform-node';
import { Event, EventChain } from 'eqty-core';
import { ethers } from 'ethers';
import JSZip from 'jszip';
import { encode } from 'cbor-x';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
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
    nft: { network: 'eip155:base', address: '0xabc', id: '1' },
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
  assert.equal(supportedUploadResponse.headers.get('location'), `/ownables/${encodeURIComponent(chain.id)}`);
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
