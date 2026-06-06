import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { HubStateRepository } from './hub-state.repository.js';

const databaseUrl = process.env.DATABASE_URL;
const repoRoot = path.resolve(__dirname, '../../..');
const migrateBin = path.join(repoRoot, 'node_modules/node-pg-migrate/bin/node-pg-migrate');
const migrationsDir = path.join(repoRoot, 'migrations');

const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('HubStateRepository local discovery postgres integration', () => {
  async function withSchema<T>(
    migrationTimestamp: string | null,
    run: (repo: HubStateRepository, client: Client) => Promise<T>,
  ): Promise<T> {
    const schema = `hub_local_discovery_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

  it('returns legacy registration-backed discovery rows on the persisted localhost schema shape', async () => {
    await withSchema('1717192000000', async (repo, client) => {
      await client.query(
        `INSERT INTO ownable_records (id, cid, prev_owner_address)
         VALUES ('00000000-0000-0000-0000-000000000001', 'cid-legacy-1', '0xissuer')`,
      );
      await client.query(
        `INSERT INTO ownable_owner_state (ownable_id, current_owner_address, owner_state_version)
         VALUES ('00000000-0000-0000-0000-000000000001', '0xowner', 3)`,
      );
      await client.query(
        `INSERT INTO notify_registrations (id, owner_address, owner_account, topic)
         VALUES ('00000000-0000-0000-0000-000000000011', '0xowner', 'eip155:84532:0xowner', 'topic-1')`,
      );
      await client.query(
        `INSERT INTO notify_delivery_state (
           id,
           registration_id,
           ownable_id,
           owner_state_version,
           trigger_kind,
           status,
           attempt_count,
           last_attempt_at,
           last_error
         ) VALUES (
           '00000000-0000-0000-0000-000000000021',
           '00000000-0000-0000-0000-000000000011',
           '00000000-0000-0000-0000-000000000001',
           3,
           'upload',
           'failed_configuration',
           1,
           '2026-06-06T10:01:00.000Z',
           'notify disabled'
         )`,
      );

      const rows = await repo.listLocalNotifyDiscoveryByOwnerAccount('eip155:84532:0xowner', '0xowner');

      expect(rows).toEqual([
        expect.objectContaining({
          ownableId: '00000000-0000-0000-0000-000000000001',
          ownerAccount: 'eip155:84532:0xowner',
          ownerAddress: '0xowner',
          notificationId: null,
          errorCode: null,
          message: 'notify disabled',
        }),
      ]);
    });
  });

  it('returns account-targeted discovery rows on the migrated notify schema', async () => {
    await withSchema(null, async (repo, client) => {
      await client.query(
        `INSERT INTO ownable_records (id, cid, prev_owner_address)
         VALUES ('00000000-0000-0000-0000-000000000101', 'cid-current-1', '0xissuer')`,
      );
      await client.query(
        `INSERT INTO ownable_owner_state (ownable_id, current_owner_address, owner_state_version)
         VALUES ('00000000-0000-0000-0000-000000000101', '0xowner', 4)`,
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
           error_code,
           last_error
         ) VALUES (
           '00000000-0000-0000-0000-000000000121',
           '00000000-0000-0000-0000-000000000101',
           '0xowner',
           'eip155:84532:0xowner',
           4,
           'download_replay',
           'failed_configuration',
           'ownables_fixed',
           1,
           '2026-06-06T10:02:00.000Z',
           'missing_reown_config',
           'notify disabled'
         )`,
      );

      const rows = await repo.listLocalNotifyDiscoveryByOwnerAccount('eip155:84532:0xowner', '0xowner');

      expect(rows).toEqual([
        expect.objectContaining({
          ownableId: '00000000-0000-0000-0000-000000000101',
          ownerAccount: 'eip155:84532:0xowner',
          ownerAddress: '0xowner',
          notificationId: 'ownables_fixed',
          errorCode: 'missing_reown_config',
          message: 'notify disabled',
        }),
      ]);
    });
  });
});
