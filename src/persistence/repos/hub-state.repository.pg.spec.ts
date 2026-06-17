import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { HubStateRepository } from './hub-state.repository.js';

const databaseUrl = process.env.DATABASE_URL;
const repoRoot = path.resolve(__dirname, '../../..');
const migrateBin = path.join(repoRoot, 'node_modules/node-pg-migrate/bin/node-pg-migrate');
const migrationsDir = path.join(repoRoot, 'migrations');

const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('HubStateRepository recipient discovery postgres integration', () => {
  function runMigrationsForSchema(schema: string, migrationTimestamp: string | null): void {
    const migrationArgs = [
      migrateBin,
      'up',
      '--migrations-dir',
      migrationsDir,
      '--schema',
      schema,
      '--create-schema',
      '--migrations-schema',
      schema,
      '--create-migrations-schema',
    ];
    if (migrationTimestamp) {
      migrationArgs.push(migrationTimestamp, '--timestamp');
    }

    execFileSync(process.execPath, migrationArgs, {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
  }

  async function withSchema<T>(
    migrationTimestamp: string | null,
    run: (repo: HubStateRepository, client: Client) => Promise<T>,
  ): Promise<T> {
    const schema = `hub_local_discovery_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    runMigrationsForSchema(schema, migrationTimestamp);

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`SET search_path TO "${schema}", public`);

    const repo = new HubStateRepository({
      query: <TResult = unknown>(text: string, values: unknown[] = []) => client.query<TResult>(text, values),
      withClient: async <TResult>(fn: (dbClient: Client) => Promise<TResult>) => fn(client),
    } as any);

    try {
      return await run(repo, client);
    } finally {
      await client.end();

      const cleanupClient = new Client({ connectionString: databaseUrl });
      await cleanupClient.connect();
      try {
        await cleanupClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanupClient.end();
      }
    }
  }

  it('returns available ownables by persisted current owner account on the migrated schema', async () => {
    await withSchema(null, async (repo, client) => {
      await client.query(
        `INSERT INTO ownable_records (id, cid, prev_owner_address, subject_id, nft_network, nft_contract_address, nft_token_id)
         VALUES (
           '00000000-0000-0000-0000-000000000001',
           'cid-available-1',
           '0xissuer',
           '0x11',
           'eip155:base',
           '0xnft',
           '1'
         )`,
      );
      await client.query(
        `INSERT INTO ownable_owner_state (
           ownable_id,
           current_owner_address,
           current_owner_account,
           owner_state_version,
           updated_at
         ) VALUES (
           '00000000-0000-0000-0000-000000000001',
           '0xowner',
           'eip155:84532:0xowner',
           3,
           '2026-06-06T10:01:00.000Z'
         )`,
      );

      const rows = await repo.listAvailableOwnablesByOwnerAccount('eip155:84532:0xowner');

      expect(rows).toEqual([
        expect.objectContaining({
          ownableId: '00000000-0000-0000-0000-000000000001',
          packageCid: 'cid-available-1',
          ownerAccount: 'eip155:84532:0xowner',
          subjectId: '0x11',
          ownerStateVersion: 3,
          issuerAddress: '0xissuer',
        }),
      ]);
    });
  });

  it('increments owner state version only when availability materially changes', async () => {
    await withSchema(null, async (repo, client) => {
      await client.query(
        `INSERT INTO ownable_records (id, cid, prev_owner_address)
         VALUES ('00000000-0000-0000-0000-000000000101', 'cid-current-1', '0xissuer')`,
      );

      await repo.setOwnerState(
        '00000000-0000-0000-0000-000000000101',
        '0xowner',
        'eip155:84532:0xowner',
        '00000000-0000-0000-0000-000000000001',
      );
      await repo.setOwnerState(
        '00000000-0000-0000-0000-000000000101',
        '0xowner',
        'eip155:84532:0xowner',
        '00000000-0000-0000-0000-000000000001',
      );
      await repo.setOwnerState(
        '00000000-0000-0000-0000-000000000101',
        '0xowner',
        'eip155:84532:0xowner',
        '00000000-0000-0000-0000-000000000002',
      );

      const persisted = await client.query<{ ownerStateVersion: number; ownerAccount: string | null }>(
        `SELECT owner_state_version AS "ownerStateVersion", current_owner_account AS "ownerAccount"
         FROM ownable_owner_state
         WHERE ownable_id = '00000000-0000-0000-0000-000000000101'`,
      );

      expect(persisted.rows).toEqual([{ ownerStateVersion: 2, ownerAccount: 'eip155:84532:0xowner' }]);
    });
  });

  it('backfills current_owner_account on upgrade from the pre-recipient-discovery schema', async () => {
    const schema = `hub_owner_account_upgrade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    runMigrationsForSchema(schema, '1717193000000');

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`SET search_path TO "${schema}", public`);

    try {
      await client.query(
        `INSERT INTO ownable_records (id, cid, prev_owner_address)
         VALUES ('00000000-0000-0000-0000-000000000301', 'cid-upgrade-1', '0xissuer')`,
      );
      await client.query(
        `INSERT INTO ownable_owner_state (ownable_id, current_owner_address, owner_state_version, updated_at)
         VALUES (
           '00000000-0000-0000-0000-000000000301',
           '0xowner',
           4,
           '2026-06-06T10:02:00.000Z'
         )`,
      );
      await client.query(
        `INSERT INTO notify_delivery_state (
           id,
           ownable_id,
           owner_address,
           owner_account,
           owner_state_version,
           trigger_kind,
           status,
           notification_id,
           attempt_count,
           last_attempt_at,
           created_at
         ) VALUES (
           '00000000-0000-0000-0000-000000000321',
           '00000000-0000-0000-0000-000000000301',
           '0xowner',
           'eip155:84532:0xowner',
           4,
           'upload',
           'failed_configuration',
           'ownables_fixed',
           1,
           '2026-06-06T10:03:00.000Z',
           '2026-06-06T10:01:00.000Z'
         )`,
      );

      runMigrationsForSchema(schema, null);

      const persisted = await client.query<{ ownerAccount: string | null }>(
        `SELECT current_owner_account AS "ownerAccount"
         FROM ownable_owner_state
         WHERE ownable_id = '00000000-0000-0000-0000-000000000301'`,
      );

      expect(persisted.rows).toEqual([{ ownerAccount: 'eip155:84532:0xowner' }]);
    } finally {
      await client.end();

      const cleanupClient = new Client({ connectionString: databaseUrl });
      await cleanupClient.connect();
      try {
        await cleanupClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanupClient.end();
      }
    }
  });

});
