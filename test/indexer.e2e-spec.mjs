import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import process from 'node:process';
import { test } from 'node:test';
import pg from 'pg';

const { Client } = pg;
const INDEXER_TIMEOUT_MS = 30_000;
const TESTNET_ANCHOR = '0x0000000000000000000000000000000000000044';
const MAINNET_ANCHOR = '0x0000000000000000000000000000000000000055';

function startRpcServer() {
  const server = createServer(async (request, response) => {
    const body = await new Promise((resolve, reject) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => resolve(raw));
      request.on('error', reject);
    });
    const message = JSON.parse(body);
    const result = message.method === 'eth_chainId' ? '0x14a34' : message.method === 'eth_blockNumber' ? '0x64' : [];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected an IPv4 JSON-RPC test server address'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function runIndexer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'dist/indexer/main.js'], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Indexer did not exit within ${INDEXER_TIMEOUT_MS}ms\n${output}`));
    }, INDEXER_TIMEOUT_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output });
    });
  });
}

test('compiled indexer exits nonzero during PostgreSQL failure and restarts from the committed cursor', { timeout: INDEXER_TIMEOUT_MS * 2 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for the compiled indexer E2E test');

  const database = new Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  await database.query(
    `INSERT INTO indexer_cursors (
       slot_name, cursor_name, chain_id, anchor_contract_address, next_from_block, last_scanned_block
     ) VALUES ('testnet', 'anchor-public-events', '84532', LOWER($1), 101, 100)
     ON CONFLICT (slot_name, cursor_name, chain_id, anchor_contract_address) DO UPDATE SET
       next_from_block = EXCLUDED.next_from_block,
       last_scanned_block = EXCLUDED.last_scanned_block,
       last_scanned_tx_hash = NULL,
       last_scanned_tx_index = NULL,
       last_scanned_log_index = NULL`,
    [TESTNET_ANCHOR],
  );
  t.after(async () => {
    try {
      await database.query(
        `DELETE FROM indexer_cursors
         WHERE slot_name = 'testnet' AND cursor_name = 'anchor-public-events' AND chain_id = '84532'
           AND anchor_contract_address = LOWER($1)`,
        [TESTNET_ANCHOR],
      );
    } finally {
      await database.end();
    }
  });

  const { server, url } = await startRpcServer();
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

  const baseEnv = {
    ...process.env,
    NODE_ENV: 'test',
    HUB_NETWORK_PROFILE: 'testnet',
    TESTNET_CHAIN_ID: '84532',
    TESTNET_RPC_URL: url,
    TESTNET_ANCHOR_CONTRACT_ADDR: TESTNET_ANCHOR,
    TESTNET_ANCHOR_START_BLOCK: '99',
    MAINNET_CHAIN_ID: '84532',
    MAINNET_RPC_URL: url,
    MAINNET_ANCHOR_CONTRACT_ADDR: MAINNET_ANCHOR,
    MAINNET_ANCHOR_START_BLOCK: '101',
  };

  const failed = await runIndexer({
    ...baseEnv,
    DATABASE_URL: 'postgres://ownables:ownables@127.0.0.1:1/ownables_hub',
  });
  assert.notEqual(failed.code, 0, `Expected unavailable PostgreSQL to fail\n${failed.output}`);

  const cursorAfterFailure = await database.query(
    `SELECT next_from_block, last_scanned_block
     FROM indexer_cursors
     WHERE slot_name = 'testnet' AND cursor_name = 'anchor-public-events' AND chain_id = '84532'
       AND anchor_contract_address = LOWER($1)`,
    [TESTNET_ANCHOR],
  );
  assert.deepEqual(cursorAfterFailure.rows, [{ next_from_block: '101', last_scanned_block: '100' }]);

  const recovered = await runIndexer(baseEnv);
  assert.equal(recovered.code, 0, `Expected indexer restart to succeed\n${recovered.output}`);
});
