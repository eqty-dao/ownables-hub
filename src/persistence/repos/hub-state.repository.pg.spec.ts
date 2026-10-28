import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { HubStateRepository } from './hub-state.repository';

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
        `INSERT INTO ownable_records (id, package_cid, prev_owner_address, subject_id)
         VALUES (
           '00000000-0000-0000-0000-000000000001',
           'cid-available-1',
           '0xissuer',
           '0x11'
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

  it('removes NFT columns from an existing schema while retaining the Ownable record', async () => {
    const schema = `hub_nft_removal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    runMigrationsForSchema(schema, '1717197000000');

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`SET search_path TO "${schema}", public`);
    try {
      await client.query(
        `INSERT INTO ownable_records (
           id, package_cid, prev_owner_address, subject_id, nft_network, nft_contract_address, nft_token_id
         ) VALUES (
           '00000000-0000-0000-0000-000000000019',
           'cid-existing-19',
           '0xissuer',
           '0x19',
           'eip155:84532',
           '0xlegacy',
           '19'
         )`,
      );

      runMigrationsForSchema(schema, null);

      const nftColumns = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'ownable_records'
           AND column_name IN ('nft_network', 'nft_contract_address', 'nft_token_id')`,
        [schema],
      );
      expect(nftColumns.rows).toEqual([]);
      const nftConstraint = await client.query(
        `SELECT conname FROM pg_constraint WHERE connamespace = $1::regnamespace AND conname = 'ownable_records_nft_unique'`,
        [schema],
      );
      expect(nftConstraint.rows).toEqual([]);
      const stored = await client.query(
        `SELECT id, package_cid, prev_owner_address, subject_id FROM ownable_records WHERE id = $1`,
        ['00000000-0000-0000-0000-000000000019'],
      );
      expect(stored.rows).toEqual([
        {
          id: '00000000-0000-0000-0000-000000000019',
          package_cid: 'cid-existing-19',
          prev_owner_address: '0xissuer',
          subject_id: '0x19',
        },
      ]);
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

  it('keeps cursor progress isolated by chain and normalized anchor identity', async () => {
    await withSchema(null, async (repo, client) => {
      const anchorA = '0x00000000000000000000000000000000000000AA';
      const anchorB = '0xE518BB784B8cB17e6F16e445A9275A16d61700b5';

      await repo.upsertIndexerCursor({
        slotName: 'testnet',
        cursorName: 'anchor-public-events',
        chainId: '84532',
        anchorContractAddress: anchorA,
        nextFromBlock: 26n,
      });

      expect(
        await repo.getIndexerCursor('testnet', 'anchor-public-events', '84532', anchorB),
      ).toBeNull();

      await repo.upsertIndexerCursor({
        slotName: 'testnet',
        cursorName: 'anchor-public-events',
        chainId: '84532',
        anchorContractAddress: anchorB,
        nextFromBlock: 100n,
      });
      await repo.upsertIndexerCursor({
        slotName: 'testnet',
        cursorName: 'anchor-public-events',
        chainId: '84532',
        anchorContractAddress: anchorA.toLowerCase(),
        nextFromBlock: 40n,
      });

      expect(
        await repo.getIndexerCursor('testnet', 'anchor-public-events', '84532', anchorA),
      ).toEqual(expect.objectContaining({ nextFromBlock: 40n, anchorContractAddress: anchorA.toLowerCase() }));
      expect(
        await repo.getIndexerCursor('testnet', 'anchor-public-events', '84532', anchorB),
      ).toEqual(expect.objectContaining({ nextFromBlock: 100n, anchorContractAddress: anchorB.toLowerCase() }));

      const rows = await client.query(
        `SELECT slot_name, cursor_name, chain_id, anchor_contract_address, next_from_block
         FROM indexer_cursors ORDER BY anchor_contract_address`,
      );
      expect(rows.rows).toEqual([
        expect.objectContaining({ anchor_contract_address: anchorA.toLowerCase(), next_from_block: '40' }),
        expect.objectContaining({ anchor_contract_address: anchorB.toLowerCase(), next_from_block: '100' }),
      ]);
    });
  });

  it('upgrades the pre-partition schema without deleting the old cursor partition', async () => {
    const schema = `hub_cursor_migration_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    runMigrationsForSchema(schema, '1717196000000');

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`SET search_path TO "${schema}", public`);
    try {
      await client.query(
        `INSERT INTO indexer_cursors (
           slot_name, cursor_name, chain_id, anchor_contract_address, next_from_block
         ) VALUES ('testnet', 'anchor-public-events', '84532', '0x00000000000000000000000000000000000000AA', 26)`,
      );

      runMigrationsForSchema(schema, null);

      const repo = new HubStateRepository({
        query: <TResult = unknown>(text: string, values: unknown[] = []) => client.query<TResult>(text, values),
        withClient: async <TResult>(fn: (dbClient: Client) => Promise<TResult>) => fn(client),
      } as any);

      expect(
        await repo.getIndexerCursor(
          'testnet',
          'anchor-public-events',
          '84532',
          '0xe518BB784B8cB17e6F16e445A9275A16d61700b5',
        ),
      ).toBeNull();
      await repo.upsertIndexerCursor({
        slotName: 'testnet',
        cursorName: 'anchor-public-events',
        chainId: '84532',
        anchorContractAddress: '0xe518BB784B8cB17e6F16e445A9275A16d61700b5',
        nextFromBlock: 100n,
      });

      const rows = await client.query(
        `SELECT anchor_contract_address, next_from_block
         FROM indexer_cursors ORDER BY anchor_contract_address`,
      );
      expect(rows.rows).toEqual([
        { anchor_contract_address: '0x00000000000000000000000000000000000000aa', next_from_block: '26' },
        { anchor_contract_address: '0xe518bb784b8cb17e6f16e445a9275a16d61700b5', next_from_block: '100' },
      ]);
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

  it('increments owner state version only when availability materially changes', async () => {
    await withSchema(null, async (repo, client) => {
      await client.query(
        `INSERT INTO ownable_records (id, package_cid, prev_owner_address)
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

  it('returns indexed anchor and public replay inputs by anchor key and ownable subject id', async () => {
    await withSchema(null, async (repo, client) => {
      const ownableId = '00000000-0000-0000-0000-000000000501';
      const subjectId = `0x${'5'.repeat(64)}`;
      await client.query(
        `INSERT INTO ownable_records (id, package_cid, prev_owner_address, subject_id)
         VALUES ($1, $2, $3, $4)`,
        [ownableId, 'cid-proof-1', '0xissuer', subjectId],
      );

      await repo.upsertIndexedAnchorEvent({
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x00000000000000000000000000000000000000aa',
        blockNumber: 10n,
        blockHash: '0xabc',
        transactionHash: '0xaaa',
        transactionIndex: 1,
        logIndex: 2,
        eventName: 'Anchored',
        cid: null,
        ownableId,
        ownerAddress: '0xowner',
        payloadJson: { key: `0x${'7'.repeat(64)}`, value: `0x${'8'.repeat(64)}` },
      });

      await repo.upsertIndexedPublicEvent({
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x00000000000000000000000000000000000000aa',
        blockNumber: 11n,
        blockHash: '0xdef',
        transactionHash: '0xbbb',
        transactionIndex: 0,
        logIndex: 3,
        eventName: 'PublicEvent',
        subjectId,
        sourceAddress: '0x00000000000000000000000000000000000000bb',
        eventType: 'transfer',
        dataHex: '0x1234',
        eventTimestamp: 42n,
        payloadJson: { public: true },
      });

      const anchorRows = await repo.listIndexedAnchorEventsByAnchorKeys([`0x${'7'.repeat(64)}`]);
      const publicRows = await repo.listIndexedPublicEventsBySubjectId(subjectId, {
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x00000000000000000000000000000000000000aa',
      });

      expect(anchorRows).toEqual([
        expect.objectContaining({
          transactionHash: '0xaaa',
          blockNumber: '10',
          transactionIndex: 1,
          logIndex: 2,
          ownerAddress: '0xowner',
        }),
      ]);
      expect(publicRows).toEqual([
        expect.objectContaining({
          transactionHash: '0xbbb',
          blockNumber: '11',
          transactionIndex: 0,
          logIndex: 3,
          subjectId,
          sourceAddress: '0x00000000000000000000000000000000000000bb',
          eventType: 'transfer',
          dataHex: '0x1234',
          eventTimestamp: '42',
        }),
      ]);
    });
  });

  it('returns only the active identity public rows while retaining other indexed identities', async () => {
    await withSchema(null, async (repo, client) => {
      const subjectId = `0x${'6'.repeat(64)}`;
      const activeIdentity = {
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0xE518BB784B8cB17e6F16e445A9275A16d61700b5',
      };
      const baseEvent = {
        blockHash: '0xabc',
        transactionIndex: 0,
        logIndex: 0,
        eventName: 'PublicEvent',
        subjectId,
        sourceAddress: '0x00000000000000000000000000000000000000bb',
        eventType: 'transfer',
        dataHex: '0x1234',
        eventTimestamp: 42n,
        payloadJson: { public: true },
      };

      await repo.upsertIndexedPublicEvent({
        ...baseEvent,
        ...activeIdentity,
        anchorContractAddress: activeIdentity.anchorContractAddress.toLowerCase(),
        blockNumber: 11n,
        transactionHash: '0xactive',
      });
      await repo.upsertIndexedPublicEvent({
        ...baseEvent,
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x00000000000000000000000000000000000000cc',
        blockNumber: 12n,
        transactionHash: '0xother-anchor',
      });
      await repo.upsertIndexedPublicEvent({
        ...baseEvent,
        slotName: 'mainnet',
        chainId: '8453',
        anchorContractAddress: activeIdentity.anchorContractAddress,
        blockNumber: 13n,
        transactionHash: '0xother-chain',
      });

      await expect(repo.listIndexedPublicEventsBySubjectId(subjectId, activeIdentity)).resolves.toEqual([
        expect.objectContaining({ transactionHash: '0xactive' }),
      ]);
      await expect(
        repo.listIndexedPublicEventsBySubjectIdsAfter(
          [subjectId],
          11n,
          { blockNumber: 10n, transactionIndex: 0, logIndex: 0 },
          activeIdentity,
        ),
      ).resolves.toEqual([expect.objectContaining({ transactionHash: '0xactive', blockNumber: '11' })]);
      await expect(client.query('SELECT id FROM indexed_public_events')).resolves.toEqual(
        expect.objectContaining({ rowCount: 3 }),
      );
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
