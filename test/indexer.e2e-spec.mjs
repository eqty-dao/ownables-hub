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
const TEST_CURSOR_TRIGGER = 'story4_indexer_cursor_failure';
const TEST_CURSOR_FUNCTION = 'story4_indexer_cursor_failure';

function startRpcServer() {
  const logRanges = [];
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
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const replies = messages.map((message) => {
      if (message.method === 'eth_getLogs') {
        const filter = message.params?.[0];
        logRanges.push({
          fromBlock: Number(BigInt(filter.fromBlock)),
          toBlock: Number(BigInt(filter.toBlock)),
        });
      }
      const result = message.method === 'eth_chainId' ? '0x14a34' : message.method === 'eth_blockNumber' ? '0x1068' : [];
      return { jsonrpc: '2.0', id: message.id, result };
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected an IPv4 JSON-RPC test server address'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}`, logRanges });
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

test('compiled indexer commits one window before PostgreSQL failure and restarts at the failed window', { timeout: INDEXER_TIMEOUT_MS * 2 }, async (t) => {
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
      await database.query(`DROP TRIGGER IF EXISTS ${TEST_CURSOR_TRIGGER} ON indexer_cursors`);
      await database.query(`DROP FUNCTION IF EXISTS ${TEST_CURSOR_FUNCTION}()`);
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

  const { server, url, logRanges } = await startRpcServer();
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
    MAINNET_ANCHOR_START_BLOCK: '4201',
  };

  await database.query(`
    CREATE OR REPLACE FUNCTION ${TEST_CURSOR_FUNCTION}() RETURNS trigger AS $$
    BEGIN
      IF NEW.slot_name = 'testnet'
        AND NEW.cursor_name = 'anchor-public-events'
        AND NEW.chain_id = '84532'
        AND NEW.anchor_contract_address = LOWER('${TESTNET_ANCHOR}')
        AND NEW.next_from_block = 4101
      THEN
        RAISE EXCEPTION 'simulated transient indexer cursor failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER ${TEST_CURSOR_TRIGGER}
      BEFORE INSERT OR UPDATE ON indexer_cursors
      FOR EACH ROW EXECUTE FUNCTION ${TEST_CURSOR_FUNCTION}();
  `);

  const failed = await runIndexer(baseEnv);
  assert.notEqual(failed.code, 0, `Expected PostgreSQL transaction failure\n${failed.output}`);

  const cursorAfterFailure = await database.query(
    `SELECT next_from_block, last_scanned_block
     FROM indexer_cursors
     WHERE slot_name = 'testnet' AND cursor_name = 'anchor-public-events' AND chain_id = '84532'
       AND anchor_contract_address = LOWER($1)`,
    [TESTNET_ANCHOR],
  );
  assert.deepEqual(cursorAfterFailure.rows, [{ next_from_block: '2101', last_scanned_block: '2100' }]);
  assert.deepEqual(logRanges, [
    { fromBlock: 101, toBlock: 2100 },
    { fromBlock: 2101, toBlock: 4100 },
  ]);

  await database.query(`DROP TRIGGER ${TEST_CURSOR_TRIGGER} ON indexer_cursors`);
  await database.query(`DROP FUNCTION ${TEST_CURSOR_FUNCTION}()`);

  const recovered = await runIndexer(baseEnv);
  assert.equal(recovered.code, 0, `Expected indexer restart to succeed\n${recovered.output}`);
  assert.deepEqual(logRanges, [
    { fromBlock: 101, toBlock: 2100 },
    { fromBlock: 2101, toBlock: 4100 },
    { fromBlock: 2101, toBlock: 4100 },
    { fromBlock: 4101, toBlock: 4200 },
  ]);
});
