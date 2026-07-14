import { Injectable } from '@nestjs/common';
import { PostgresService } from '../postgres.service.js';
import type { PoolClient } from 'pg';

export interface OwnableRecordInput {
  packageCid: string;
  prevOwnerAddress: string;
  subjectId?: string;
  nftNetwork?: string;
  nftContractAddress?: string;
  nftTokenId?: string;
  chainFileName?: string;
}

export interface OwnableRecord {
  id: string;
  packageCid: string;
  prevOwnerAddress: string;
  subjectId: string | null;
  nftNetwork: string | null;
  nftContractAddress: string | null;
  nftTokenId: string | null;
}

export interface IndexedWalletEvent {
  id: string;
  eventKind: 'anchor' | 'public';
  slotName: string;
  chainId: string;
  anchorContractAddress: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  eventName: string;
  cid: string | null;
  ownableId: string | null;
  ownerAddress: string | null;
  subjectId: string | null;
  sourceAddress: string | null;
  eventType: string | null;
  dataHex: string | null;
  eventTimestamp: string | null;
  payloadJson: unknown;
  indexedAt: string;
}

export interface IndexedAnchorEvent {
  id: string;
  slotName: string;
  chainId: string;
  anchorContractAddress: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  eventName: string;
  cid: string | null;
  ownableId: string | null;
  ownerAddress: string | null;
  payloadJson: unknown;
  indexedAt: string;
}

export interface IndexedPublicEventRow {
  id: string;
  slotName: string;
  chainId: string;
  anchorContractAddress: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  eventName: string;
  cid: string | null;
  ownableId: string | null;
  subjectId: string | null;
  sourceAddress: string | null;
  eventType: string | null;
  dataHex: string | null;
  eventTimestamp: string | null;
  payloadJson: unknown;
  indexedAt: string;
}

export interface IndexedPublicEventCursor {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
}

export interface IndexerCursorState {
  slotName: 'testnet' | 'mainnet';
  cursorName: string;
  chainId: string;
  anchorContractAddress: string;
  nextFromBlock: bigint;
  lastScannedBlock: bigint | null;
  lastScannedTxHash: string | null;
  lastScannedTxIndex: number | null;
  lastScannedLogIndex: number | null;
}

export interface OwnerStateRow {
  owner: string;
  ownerAccount: string | null;
  version: number;
  latestAppliedPublicEventId: string | null;
  updatedAt: string;
}

export interface AvailableOwnableRow {
  ownableId: string;
  packageCid: string;
  subjectId: string | null;
  ownerAccount: string;
  ownerStateVersion: number;
  availableAt: string;
  issuerAddress: string;
  nftNetwork: string | null;
  nftContractAddress: string | null;
  nftTokenId: string | null;
}

@Injectable()
export class HubStateRepository {
  constructor(private readonly db: PostgresService) {}

  async upsertOwnableRecord(input: OwnableRecordInput): Promise<OwnableRecord> {
    const values = [
      input.packageCid,
      input.prevOwnerAddress,
      input.subjectId ?? null,
      input.nftNetwork ?? null,
      input.nftContractAddress ?? null,
      input.nftTokenId ?? null,
      input.chainFileName ?? 'eventChain.json',
    ];
    const sql =
      input.subjectId != null
        ? `INSERT INTO ownable_records (
             package_cid,
             prev_owner_address,
             subject_id,
             nft_network,
             nft_contract_address,
             nft_token_id,
             chain_file_name
           ) VALUES ($1, LOWER($2), LOWER($3), $4, $5, $6, $7)
           ON CONFLICT (subject_id) WHERE subject_id IS NOT NULL DO UPDATE SET
             package_cid = EXCLUDED.package_cid,
             prev_owner_address = EXCLUDED.prev_owner_address,
             nft_network = EXCLUDED.nft_network,
             nft_contract_address = EXCLUDED.nft_contract_address,
             nft_token_id = EXCLUDED.nft_token_id,
             chain_file_name = EXCLUDED.chain_file_name,
             updated_at = NOW()
           RETURNING id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"`
        : `INSERT INTO ownable_records (
             package_cid,
             prev_owner_address,
             subject_id,
             nft_network,
             nft_contract_address,
             nft_token_id,
             chain_file_name
           ) VALUES ($1, LOWER($2), LOWER($3), $4, $5, $6, $7)
           RETURNING id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"`;

    const result = await this.db.query<OwnableRecord>(sql, values);

    return result.rows[0] as OwnableRecord;
  }

  async getOwnableByCid(cid: string): Promise<OwnableRecord | null> {
    const result = await this.db.query<OwnableRecord>(
      `SELECT id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"
       FROM ownable_records
       WHERE package_cid = $1
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [cid],
    );

    return result.rows[0] ?? null;
  }

  async getOwnableByNft(nftNetwork: string, nftContractAddress: string, nftTokenId: string): Promise<OwnableRecord | null> {
    const result = await this.db.query<OwnableRecord>(
      `SELECT id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"
       FROM ownable_records
       WHERE nft_network = $1 AND nft_contract_address = $2 AND nft_token_id = $3`,
      [nftNetwork, nftContractAddress, nftTokenId],
    );

    return result.rows[0] ?? null;
  }

  async getOwnableBySubjectId(subjectId: string): Promise<OwnableRecord | null> {
    const result = await this.db.query<OwnableRecord>(
      `SELECT id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"
       FROM ownable_records
       WHERE subject_id = LOWER($1)
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [subjectId],
    );

    return result.rows[0] ?? null;
  }

  async listOwnableCidsByPrevOwner(address: string): Promise<string[]> {
    const result = await this.db.query<{ packageCid: string }>(
      'SELECT package_cid AS "packageCid" FROM ownable_records WHERE prev_owner_address = LOWER($1) ORDER BY created_at ASC',
      [address],
    );

    return result.rows.map((row) => row.packageCid);
  }

  async setOwnerState(
    ownableId: string,
    currentOwnerAddress: string,
    currentOwnerAccount: string | null,
    lastAppliedPublicEventId?: string | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO ownable_owner_state (ownable_id, current_owner_address, current_owner_account, last_applied_public_event_id, owner_state_version)
       VALUES ($1, LOWER($2), $3, $4, 1)
       ON CONFLICT (ownable_id) DO UPDATE SET
         current_owner_address = EXCLUDED.current_owner_address,
         current_owner_account = EXCLUDED.current_owner_account,
         last_applied_public_event_id = EXCLUDED.last_applied_public_event_id,
         owner_state_version = CASE
           WHEN ownable_owner_state.current_owner_address IS DISTINCT FROM EXCLUDED.current_owner_address
             OR ownable_owner_state.current_owner_account IS DISTINCT FROM EXCLUDED.current_owner_account
             OR ownable_owner_state.last_applied_public_event_id IS DISTINCT FROM EXCLUDED.last_applied_public_event_id
           THEN ownable_owner_state.owner_state_version + 1
           ELSE ownable_owner_state.owner_state_version
         END,
         updated_at = CASE
           WHEN ownable_owner_state.current_owner_address IS DISTINCT FROM EXCLUDED.current_owner_address
             OR ownable_owner_state.current_owner_account IS DISTINCT FROM EXCLUDED.current_owner_account
             OR ownable_owner_state.last_applied_public_event_id IS DISTINCT FROM EXCLUDED.last_applied_public_event_id
           THEN NOW()
           ELSE ownable_owner_state.updated_at
         END`,
      [ownableId, currentOwnerAddress, currentOwnerAccount, lastAppliedPublicEventId ?? null],
    );
  }

  async getOwnerStateByCid(cid: string): Promise<OwnerStateRow | null> {
    const result = await this.db.query<OwnerStateRow>(
      `SELECT
         s.current_owner_address AS owner,
         s.current_owner_account AS "ownerAccount",
         s.owner_state_version AS version,
         s.last_applied_public_event_id AS "latestAppliedPublicEventId",
         s.updated_at AS "updatedAt"
       FROM ownable_owner_state s
       INNER JOIN ownable_records o ON o.id = s.ownable_id
       WHERE o.package_cid = $1
       ORDER BY o.updated_at DESC, o.created_at DESC
       LIMIT 1`,
      [cid],
    );

    return result.rows[0] ?? null;
  }

  private async runQuery<T = unknown>(text: string, values: unknown[] = [], client?: PoolClient) {
    if (client) {
      return client.query<T>(text, values);
    }
    return this.db.query<T>(text, values);
  }

  async getIndexerCursor(
    slotName: 'testnet' | 'mainnet',
    cursorName: string,
    chainId: string,
    anchorContractAddress: string,
  ): Promise<IndexerCursorState | null> {
    const result = await this.db.query<IndexerCursorState>(
      `SELECT
         slot_name AS "slotName",
         cursor_name AS "cursorName",
         chain_id AS "chainId",
         anchor_contract_address AS "anchorContractAddress",
         next_from_block AS "nextFromBlock",
         last_scanned_block AS "lastScannedBlock",
         last_scanned_tx_hash AS "lastScannedTxHash",
         last_scanned_tx_index AS "lastScannedTxIndex",
         last_scanned_log_index AS "lastScannedLogIndex"
       FROM indexer_cursors
       WHERE slot_name = $1 AND cursor_name = $2 AND chain_id = $3 AND anchor_contract_address = LOWER($4)`,
      [slotName, cursorName, chainId, anchorContractAddress],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      slotName: row.slotName,
      cursorName: row.cursorName,
      chainId: row.chainId,
      anchorContractAddress: row.anchorContractAddress,
      nextFromBlock: BigInt(row.nextFromBlock),
      lastScannedBlock: row.lastScannedBlock === null ? null : BigInt(row.lastScannedBlock),
      lastScannedTxHash: row.lastScannedTxHash,
      lastScannedTxIndex: row.lastScannedTxIndex,
      lastScannedLogIndex: row.lastScannedLogIndex,
    };
  }

  async upsertIndexerCursor(input: {
    slotName: 'testnet' | 'mainnet';
    cursorName: string;
    chainId: string;
    anchorContractAddress: string;
    nextFromBlock: bigint;
    lastScannedBlock?: bigint | null;
    lastScannedTxHash?: string | null;
    lastScannedTxIndex?: number | null;
    lastScannedLogIndex?: number | null;
  }, client?: PoolClient): Promise<void> {
    await this.runQuery(
      `INSERT INTO indexer_cursors (
         slot_name,
         cursor_name,
         chain_id,
         anchor_contract_address,
         next_from_block,
         last_scanned_block,
         last_scanned_tx_hash,
         last_scanned_tx_index,
         last_scanned_log_index
       ) VALUES ($1, $2, $3, LOWER($4), $5, $6, $7, $8, $9)
       ON CONFLICT (slot_name, cursor_name, chain_id, anchor_contract_address) DO UPDATE SET
         next_from_block = EXCLUDED.next_from_block,
         last_scanned_block = EXCLUDED.last_scanned_block,
         last_scanned_tx_hash = EXCLUDED.last_scanned_tx_hash,
         last_scanned_tx_index = EXCLUDED.last_scanned_tx_index,
         last_scanned_log_index = EXCLUDED.last_scanned_log_index,
         updated_at = NOW()`,
      [
        input.slotName,
        input.cursorName,
        input.chainId,
        input.anchorContractAddress,
        input.nextFromBlock.toString(),
        input.lastScannedBlock?.toString() ?? null,
        input.lastScannedTxHash ?? null,
        input.lastScannedTxIndex ?? null,
        input.lastScannedLogIndex ?? null,
      ],
      client,
    );
  }

  async listAvailableOwnablesByOwnerAccount(ownerAccount: string): Promise<AvailableOwnableRow[]> {
    const result = await this.db.query<AvailableOwnableRow>(
      `SELECT
         os.ownable_id AS "ownableId",
         o.package_cid AS "packageCid",
         o.subject_id AS "subjectId",
         os.current_owner_account AS "ownerAccount",
         os.owner_state_version AS "ownerStateVersion",
         os.updated_at AS "availableAt",
         o.prev_owner_address AS "issuerAddress",
         o.nft_network AS "nftNetwork",
         o.nft_contract_address AS "nftContractAddress",
         o.nft_token_id AS "nftTokenId"
       FROM ownable_owner_state os
       INNER JOIN ownable_records o ON o.id = os.ownable_id
       WHERE os.current_owner_account = $1
       ORDER BY os.updated_at DESC, os.ownable_id ASC, os.owner_state_version ASC`,
      [ownerAccount],
    );
    return result.rows;
  }

  async upsertIndexedAnchorEvent(input: {
    slotName: string;
    chainId: string;
    anchorContractAddress: string;
    blockNumber: bigint;
    blockHash: string;
    transactionHash: string;
    transactionIndex: number;
    logIndex: number;
    eventName: string;
    cid?: string | null;
    ownableId?: string | null;
    ownerAddress?: string | null;
    payloadJson: unknown;
  }, client?: PoolClient): Promise<void> {
    await this.runQuery(
      `INSERT INTO indexed_anchor_events (
         slot_name,
         chain_id,
         anchor_contract_address,
         block_number,
         block_hash,
         transaction_hash,
         transaction_index,
         log_index,
         event_name,
         package_cid,
         ownable_id,
         owner_address,
         payload_json
       ) VALUES ($1, $2, LOWER($3), $4, LOWER($5), LOWER($6), $7, $8, $9, $10, $11, LOWER($12), $13::jsonb)
       ON CONFLICT (slot_name, transaction_hash, log_index) DO UPDATE SET
         chain_id = EXCLUDED.chain_id,
         anchor_contract_address = EXCLUDED.anchor_contract_address,
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
         transaction_index = EXCLUDED.transaction_index,
         event_name = EXCLUDED.event_name,
         package_cid = EXCLUDED.package_cid,
         ownable_id = EXCLUDED.ownable_id,
         owner_address = EXCLUDED.owner_address,
         payload_json = EXCLUDED.payload_json,
         indexed_at = NOW()`,
      [
        input.slotName,
        input.chainId,
        input.anchorContractAddress,
        input.blockNumber.toString(),
        input.blockHash,
        input.transactionHash,
        input.transactionIndex,
        input.logIndex,
        input.eventName,
        input.cid ?? null,
        input.ownableId ?? null,
        input.ownerAddress ?? null,
        JSON.stringify(input.payloadJson),
      ],
      client,
    );
  }

  async upsertIndexedPublicEvent(input: {
    slotName: string;
    chainId: string;
    anchorContractAddress: string;
    blockNumber: bigint;
    blockHash: string;
    transactionHash: string;
    transactionIndex: number;
    logIndex: number;
    eventName: string;
    subjectId: string;
    sourceAddress: string;
    eventType: string;
    dataHex: string;
    eventTimestamp: bigint;
    payloadJson: unknown;
  }, client?: PoolClient): Promise<void> {
    await this.runQuery(
      `INSERT INTO indexed_public_events (
         slot_name,
         chain_id,
         anchor_contract_address,
         block_number,
         block_hash,
         transaction_hash,
         transaction_index,
         log_index,
         event_name,
         ownable_id,
         package_cid,
         subject_id,
         source_address,
         event_type,
         data_hex,
         event_timestamp,
         payload_json
       ) VALUES (
         $1,
         $2,
         LOWER($3),
         $4,
         LOWER($5),
         LOWER($6),
         $7,
         $8,
         $9,
         (SELECT id FROM ownable_records WHERE subject_id = LOWER($10) LIMIT 1),
         (SELECT package_cid FROM ownable_records WHERE subject_id = LOWER($10) LIMIT 1),
         LOWER($10),
         LOWER($11),
         $12,
         LOWER($13),
         $14,
         $15::jsonb
       )
       ON CONFLICT (slot_name, transaction_hash, log_index) DO UPDATE SET
         chain_id = EXCLUDED.chain_id,
         anchor_contract_address = EXCLUDED.anchor_contract_address,
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
         transaction_index = EXCLUDED.transaction_index,
         event_name = EXCLUDED.event_name,
         ownable_id = EXCLUDED.ownable_id,
         package_cid = EXCLUDED.package_cid,
         subject_id = EXCLUDED.subject_id,
         source_address = EXCLUDED.source_address,
         event_type = EXCLUDED.event_type,
         data_hex = EXCLUDED.data_hex,
         event_timestamp = EXCLUDED.event_timestamp,
         payload_json = EXCLUDED.payload_json,
         indexed_at = NOW()`,
      [
        input.slotName,
        input.chainId,
        input.anchorContractAddress,
        input.blockNumber.toString(),
        input.blockHash,
        input.transactionHash,
        input.transactionIndex,
        input.logIndex,
        input.eventName,
        input.subjectId,
        input.sourceAddress,
        input.eventType,
        input.dataHex,
        input.eventTimestamp.toString(),
        JSON.stringify(input.payloadJson),
      ],
      client,
    );
  }

  async withIndexerPersistenceTransaction(input: {
    slotName: 'testnet' | 'mainnet';
    cursorName: string;
    chainId: string;
    anchorContractAddress: string;
    nextFromBlock: bigint;
    lastScannedBlock?: bigint | null;
    lastScannedTxHash?: string | null;
    lastScannedTxIndex?: number | null;
    lastScannedLogIndex?: number | null;
    anchorEvents: Array<{
      slotName: string;
      chainId: string;
      anchorContractAddress: string;
      blockNumber: bigint;
      blockHash: string;
      transactionHash: string;
      transactionIndex: number;
      logIndex: number;
      eventName: string;
      cid?: string | null;
      ownableId?: string | null;
      ownerAddress?: string | null;
      payloadJson: unknown;
    }>;
    publicEvents: Array<{
      slotName: string;
      chainId: string;
      anchorContractAddress: string;
      blockNumber: bigint;
      blockHash: string;
      transactionHash: string;
      transactionIndex: number;
      logIndex: number;
      eventName: string;
      subjectId: string;
      sourceAddress: string;
      eventType: string;
      dataHex: string;
      eventTimestamp: bigint;
      payloadJson: unknown;
    }>;
  }): Promise<void> {
    await this.db.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        for (const event of input.anchorEvents) {
          await this.upsertIndexedAnchorEvent(event, client);
        }
        for (const event of input.publicEvents) {
          await this.upsertIndexedPublicEvent(event, client);
        }
        await this.upsertIndexerCursor(
          {
            slotName: input.slotName,
            cursorName: input.cursorName,
            chainId: input.chainId,
            anchorContractAddress: input.anchorContractAddress,
            nextFromBlock: input.nextFromBlock,
            lastScannedBlock: input.lastScannedBlock ?? null,
            lastScannedTxHash: input.lastScannedTxHash ?? null,
            lastScannedTxIndex: input.lastScannedTxIndex ?? null,
            lastScannedLogIndex: input.lastScannedLogIndex ?? null,
          },
          client,
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async listWalletEventsByCid(cid: string): Promise<IndexedWalletEvent[]> {
    const result = await this.db.query<IndexedWalletEvent>(
      `SELECT * FROM (
         SELECT
           id,
           'anchor'::text AS "eventKind",
           slot_name AS "slotName",
           chain_id AS "chainId",
           anchor_contract_address AS "anchorContractAddress",
           block_number::text AS "blockNumber",
           block_hash AS "blockHash",
           transaction_hash AS "transactionHash",
           transaction_index AS "transactionIndex",
           log_index AS "logIndex",
           event_name AS "eventName",
           package_cid AS cid,
           ownable_id AS "ownableId",
           owner_address AS "ownerAddress",
           NULL::text AS "subjectId",
           NULL::text AS "sourceAddress",
           NULL::text AS "eventType",
           NULL::text AS "dataHex",
           NULL::text AS "eventTimestamp",
           payload_json AS "payloadJson",
           indexed_at::text AS "indexedAt"
         FROM indexed_anchor_events
         WHERE package_cid = $1
         UNION ALL
         SELECT
           id,
           'public'::text AS "eventKind",
           slot_name AS "slotName",
           chain_id AS "chainId",
           anchor_contract_address AS "anchorContractAddress",
           block_number::text AS "blockNumber",
           block_hash AS "blockHash",
           transaction_hash AS "transactionHash",
           transaction_index AS "transactionIndex",
           log_index AS "logIndex",
           event_name AS "eventName",
           package_cid AS cid,
           ownable_id AS "ownableId",
           NULL::text AS "ownerAddress",
           subject_id AS "subjectId",
           source_address AS "sourceAddress",
           event_type AS "eventType",
           data_hex AS "dataHex",
           event_timestamp::text AS "eventTimestamp",
           payload_json AS "payloadJson",
           indexed_at::text AS "indexedAt"
         FROM indexed_public_events
         WHERE ownable_id IN (
           SELECT id
           FROM ownable_records
           WHERE package_cid = $1
         )
         OR subject_id IN (
           SELECT subject_id
           FROM ownable_records
           WHERE package_cid = $1
         )
       ) wallet_events
       ORDER BY "blockNumber"::numeric ASC, "transactionIndex" ASC, "logIndex" ASC`,
      [cid],
    );

    return result.rows;
  }

  async listIndexedAnchorEventsByPackageCid(packageCid: string): Promise<IndexedAnchorEvent[]> {
    const result = await this.db.query<IndexedAnchorEvent>(
      `SELECT
         id,
         slot_name AS "slotName",
         chain_id AS "chainId",
         anchor_contract_address AS "anchorContractAddress",
         block_number::text AS "blockNumber",
         block_hash AS "blockHash",
         transaction_hash AS "transactionHash",
         transaction_index AS "transactionIndex",
         log_index AS "logIndex",
         event_name AS "eventName",
         package_cid AS cid,
         ownable_id AS "ownableId",
         owner_address AS "ownerAddress",
         payload_json AS "payloadJson",
         indexed_at::text AS "indexedAt"
       FROM indexed_anchor_events
       WHERE package_cid = $1
       ORDER BY block_number ASC, transaction_index ASC, log_index ASC`,
      [packageCid],
    );

    return result.rows;
  }

  async listIndexedAnchorEventsByAnchorKeys(anchorKeys: string[]): Promise<IndexedAnchorEvent[]> {
    if (!anchorKeys.length) {
      return [];
    }

    const normalizedAnchorKeys = anchorKeys.map((anchorKey) => anchorKey.toLowerCase());
    const result = await this.db.query<IndexedAnchorEvent>(
      `SELECT
         id,
         slot_name AS "slotName",
         chain_id AS "chainId",
         anchor_contract_address AS "anchorContractAddress",
         block_number::text AS "blockNumber",
         block_hash AS "blockHash",
         transaction_hash AS "transactionHash",
         transaction_index AS "transactionIndex",
         log_index AS "logIndex",
         event_name AS "eventName",
         package_cid AS cid,
         ownable_id AS "ownableId",
         owner_address AS "ownerAddress",
         payload_json AS "payloadJson",
         indexed_at::text AS "indexedAt"
       FROM indexed_anchor_events
       WHERE LOWER(payload_json ->> 'key') = ANY($1::text[])
       ORDER BY block_number ASC, transaction_index ASC, log_index ASC`,
      [normalizedAnchorKeys],
    );

    return result.rows;
  }

  async listIndexedPublicEventsBySubjectId(subjectId: string): Promise<IndexedPublicEventRow[]> {
    const result = await this.db.query<IndexedPublicEventRow>(
      `SELECT
         id,
         slot_name AS "slotName",
         chain_id AS "chainId",
         anchor_contract_address AS "anchorContractAddress",
         block_number::text AS "blockNumber",
         block_hash AS "blockHash",
         transaction_hash AS "transactionHash",
         transaction_index AS "transactionIndex",
         log_index AS "logIndex",
         event_name AS "eventName",
         package_cid AS cid,
         ownable_id AS "ownableId",
         subject_id AS "subjectId",
         source_address AS "sourceAddress",
         event_type AS "eventType",
         data_hex AS "dataHex",
         event_timestamp::text AS "eventTimestamp",
         payload_json AS "payloadJson",
         indexed_at::text AS "indexedAt"
       FROM indexed_public_events
       WHERE subject_id = LOWER($1)
       ORDER BY block_number ASC, transaction_index ASC, log_index ASC`,
      [subjectId],
    );

    return result.rows;
  }

  async listIndexedPublicEventsBySubjectIdsAfter(
    subjectIds: string[],
    fromBlock: bigint,
    cursor?: IndexedPublicEventCursor | null,
  ): Promise<IndexedPublicEventRow[]> {
    if (!subjectIds.length) {
      return [];
    }

    const normalizedSubjectIds = subjectIds.map((subjectId) => subjectId.toLowerCase());
    const result = await this.db.query<IndexedPublicEventRow>(
      `SELECT
         id,
         slot_name AS "slotName",
         chain_id AS "chainId",
         anchor_contract_address AS "anchorContractAddress",
         block_number::text AS "blockNumber",
         block_hash AS "blockHash",
         transaction_hash AS "transactionHash",
         transaction_index AS "transactionIndex",
         log_index AS "logIndex",
         event_name AS "eventName",
         package_cid AS cid,
         ownable_id AS "ownableId",
         subject_id AS "subjectId",
         source_address AS "sourceAddress",
         event_type AS "eventType",
         data_hex AS "dataHex",
         event_timestamp::text AS "eventTimestamp",
         payload_json AS "payloadJson",
         indexed_at::text AS "indexedAt"
       FROM indexed_public_events
       WHERE subject_id = ANY($1::text[])
         AND block_number >= $2::numeric
         AND (
           $3::numeric IS NULL
           OR block_number > $3::numeric
           OR (block_number = $3::numeric AND transaction_index > $4)
           OR (block_number = $3::numeric AND transaction_index = $4 AND log_index > $5)
         )
       ORDER BY block_number ASC, transaction_index ASC, log_index ASC`,
      [
        normalizedSubjectIds,
        fromBlock.toString(),
        cursor ? cursor.blockNumber.toString() : null,
        cursor?.transactionIndex ?? null,
        cursor?.logIndex ?? null,
      ],
    );

    return result.rows;
  }
}
