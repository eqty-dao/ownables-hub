import { Injectable } from '@nestjs/common';
import { PostgresService } from '../postgres.service.js';
import type { PoolClient } from 'pg';

export interface OwnableRecordInput {
  cid: string;
  prevOwnerAddress: string;
  subjectId?: string;
  nftNetwork?: string;
  nftContractAddress?: string;
  nftTokenId?: string;
  chainFileName?: string;
}

export interface OwnableRecord {
  id: string;
  cid: string;
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
  version: number;
  latestAppliedPublicEventId: string | null;
}

export interface NotifyRegistrationRow {
  id: string;
  ownerAddress: string;
  ownerAccount: string;
  topic: string;
  status: 'active' | 'stale' | 'replaced';
}

export interface NotifyDeliveryStateRow {
  id: string;
  registrationId: string;
  ownableId: string;
  ownerStateVersion: number;
  triggerKind: string;
  status: string;
  attemptCount: number;
}

export interface AvailableOwnableRow {
  ownableId: string;
  cid: string;
  ownerAddress: string;
  ownerStateVersion: number;
  latestAppliedPublicEventId: string | null;
  prevOwnerAddress: string;
  nftNetwork: string | null;
  nftContractAddress: string | null;
  nftTokenId: string | null;
}

@Injectable()
export class HubStateRepository {
  constructor(private readonly db: PostgresService) {}

  async upsertOwnableRecord(input: OwnableRecordInput): Promise<OwnableRecord> {
    const result = await this.db.query<OwnableRecord>(
      `INSERT INTO ownable_records (
         cid,
         prev_owner_address,
         subject_id,
         nft_network,
         nft_contract_address,
         nft_token_id,
         chain_file_name
       ) VALUES ($1, LOWER($2), LOWER($3), $4, $5, $6, $7)
       ON CONFLICT (cid) DO UPDATE SET
         prev_owner_address = EXCLUDED.prev_owner_address,
         subject_id = EXCLUDED.subject_id,
         nft_network = EXCLUDED.nft_network,
         nft_contract_address = EXCLUDED.nft_contract_address,
         nft_token_id = EXCLUDED.nft_token_id,
         chain_file_name = EXCLUDED.chain_file_name,
         updated_at = NOW()
       RETURNING id, cid, prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"`,
      [
        input.cid,
        input.prevOwnerAddress,
        input.subjectId ?? null,
        input.nftNetwork ?? null,
        input.nftContractAddress ?? null,
        input.nftTokenId ?? null,
        input.chainFileName ?? 'eventChain.json',
      ],
    );

    return result.rows[0] as OwnableRecord;
  }

  async getOwnableByCid(cid: string): Promise<OwnableRecord | null> {
    const result = await this.db.query<OwnableRecord>(
      `SELECT id, cid, prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"
       FROM ownable_records WHERE cid = $1`,
      [cid],
    );

    return result.rows[0] ?? null;
  }

  async getOwnableByNft(nftNetwork: string, nftContractAddress: string, nftTokenId: string): Promise<OwnableRecord | null> {
    const result = await this.db.query<OwnableRecord>(
      `SELECT id, cid, prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"
       FROM ownable_records
       WHERE nft_network = $1 AND nft_contract_address = $2 AND nft_token_id = $3`,
      [nftNetwork, nftContractAddress, nftTokenId],
    );

    return result.rows[0] ?? null;
  }

  async listOwnableCidsByPrevOwner(address: string): Promise<string[]> {
    const result = await this.db.query<{ cid: string }>(
      'SELECT cid FROM ownable_records WHERE prev_owner_address = LOWER($1) ORDER BY created_at ASC',
      [address],
    );

    return result.rows.map((row) => row.cid);
  }

  async setOwnerState(ownableId: string, currentOwnerAddress: string, lastAppliedPublicEventId?: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO ownable_owner_state (ownable_id, current_owner_address, last_applied_public_event_id, owner_state_version)
       VALUES ($1, LOWER($2), $3, 1)
       ON CONFLICT (ownable_id) DO UPDATE SET
         current_owner_address = EXCLUDED.current_owner_address,
         last_applied_public_event_id = EXCLUDED.last_applied_public_event_id,
         owner_state_version = ownable_owner_state.owner_state_version + 1,
         updated_at = NOW()`,
      [ownableId, currentOwnerAddress, lastAppliedPublicEventId ?? null],
    );
  }

  async getOwnerStateByCid(cid: string): Promise<OwnerStateRow | null> {
    const result = await this.db.query<OwnerStateRow>(
      `SELECT s.current_owner_address AS owner, s.owner_state_version AS version, s.last_applied_public_event_id AS "latestAppliedPublicEventId"
       FROM ownable_owner_state s
       INNER JOIN ownable_records o ON o.id = s.ownable_id
       WHERE o.cid = $1`,
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

  async getIndexerCursor(slotName: 'testnet' | 'mainnet', cursorName: string): Promise<IndexerCursorState | null> {
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
       WHERE slot_name = $1 AND cursor_name = $2`,
      [slotName, cursorName],
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
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slot_name, cursor_name) DO UPDATE SET
         chain_id = EXCLUDED.chain_id,
         anchor_contract_address = EXCLUDED.anchor_contract_address,
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

  async upsertNotifyRegistration(input: {
    ownerAddress: string;
    ownerAccount: string;
    topic: string;
    status?: 'active' | 'stale' | 'replaced';
  }): Promise<NotifyRegistrationRow> {
    const result = await this.db.query<NotifyRegistrationRow>(
      `INSERT INTO notify_registrations (owner_address, owner_account, topic, status, last_seen_at)
       VALUES (LOWER($1), $2, $3, $4, NOW())
       ON CONFLICT (owner_address, topic) DO UPDATE SET
         owner_account = EXCLUDED.owner_account,
         status = EXCLUDED.status,
         stale_reason = NULL,
         replaced_by_registration_id = NULL,
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING id, owner_address AS "ownerAddress", owner_account AS "ownerAccount", topic, status`,
      [input.ownerAddress, input.ownerAccount, input.topic, input.status ?? 'active'],
    );
    return result.rows[0] as NotifyRegistrationRow;
  }

  async upsertNotifyDeliveryState(input: {
    registrationId: string;
    ownableId: string;
    ownerStateVersion: number;
    triggerKind: string;
    status?: string;
    attemptCount?: number;
    lastError?: string | null;
  }): Promise<NotifyDeliveryStateRow> {
    const result = await this.db.query<NotifyDeliveryStateRow>(
      `INSERT INTO notify_delivery_state (
         registration_id,
         ownable_id,
         owner_state_version,
         trigger_kind,
         status,
         attempt_count,
         last_error,
         last_attempt_at,
         delivered_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), CASE WHEN $5 = 'delivered' THEN NOW() ELSE NULL END)
       ON CONFLICT (registration_id, ownable_id, owner_state_version, trigger_kind) DO UPDATE SET
         status = EXCLUDED.status,
         attempt_count = EXCLUDED.attempt_count,
         last_error = EXCLUDED.last_error,
         last_attempt_at = NOW(),
         delivered_at = CASE WHEN EXCLUDED.status = 'delivered' THEN NOW() ELSE notify_delivery_state.delivered_at END
       RETURNING id, registration_id AS "registrationId", ownable_id AS "ownableId", owner_state_version AS "ownerStateVersion", trigger_kind AS "triggerKind", status, attempt_count AS "attemptCount"`,
      [
        input.registrationId,
        input.ownableId,
        input.ownerStateVersion,
        input.triggerKind,
        input.status ?? 'pending',
        input.attemptCount ?? 0,
        input.lastError ?? null,
      ],
    );
    return result.rows[0] as NotifyDeliveryStateRow;
  }

  async listActiveNotifyRegistrationsByOwner(ownerAddress: string): Promise<NotifyRegistrationRow[]> {
    const result = await this.db.query<NotifyRegistrationRow>(
      `SELECT id, owner_address AS "ownerAddress", owner_account AS "ownerAccount", topic, status
       FROM notify_registrations
       WHERE owner_address = LOWER($1) AND status = 'active'
       ORDER BY created_at ASC`,
      [ownerAddress],
    );
    return result.rows;
  }

  async markNotifyRegistrationReplaced(ownerAddress: string, topic: string, replacedByRegistrationId: string): Promise<void> {
    await this.db.query(
      `UPDATE notify_registrations
       SET status = 'replaced',
           replaced_by_registration_id = $3,
           updated_at = NOW()
       WHERE owner_address = LOWER($1) AND topic = $2`,
      [ownerAddress, topic, replacedByRegistrationId],
    );
  }

  async markNotifyRegistrationStale(registrationId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE notify_registrations
       SET status = 'stale',
           stale_reason = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [registrationId, reason],
    );
  }

  async getNotifyDeliveryState(input: {
    registrationId: string;
    ownableId: string;
    ownerStateVersion: number;
    triggerKind: string;
  }): Promise<NotifyDeliveryStateRow | null> {
    const result = await this.db.query<NotifyDeliveryStateRow>(
      `SELECT id, registration_id AS "registrationId", ownable_id AS "ownableId", owner_state_version AS "ownerStateVersion", trigger_kind AS "triggerKind", status, attempt_count AS "attemptCount"
       FROM notify_delivery_state
       WHERE registration_id = $1
         AND ownable_id = $2
         AND owner_state_version = $3
         AND trigger_kind = $4
       LIMIT 1`,
      [input.registrationId, input.ownableId, input.ownerStateVersion, input.triggerKind],
    );
    return result.rows[0] ?? null;
  }

  async listAvailableOwnablesByOwner(ownerAddress: string): Promise<AvailableOwnableRow[]> {
    const result = await this.db.query<AvailableOwnableRow>(
      `SELECT
         o.id AS "ownableId",
         o.cid AS "cid",
         s.current_owner_address AS "ownerAddress",
         s.owner_state_version AS "ownerStateVersion",
         s.last_applied_public_event_id AS "latestAppliedPublicEventId",
         o.prev_owner_address AS "prevOwnerAddress",
         o.nft_network AS "nftNetwork",
         o.nft_contract_address AS "nftContractAddress",
         o.nft_token_id AS "nftTokenId"
       FROM ownable_owner_state s
       INNER JOIN ownable_records o ON o.id = s.ownable_id
       WHERE s.current_owner_address = LOWER($1)
       ORDER BY o.created_at ASC`,
      [ownerAddress],
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
         cid,
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
         cid = EXCLUDED.cid,
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
         cid,
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
         (SELECT cid FROM ownable_records WHERE subject_id = LOWER($10) LIMIT 1),
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
         cid = EXCLUDED.cid,
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
           cid,
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
         WHERE cid = $1
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
           cid,
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
           WHERE cid = $1
         )
         OR subject_id IN (
           SELECT subject_id
           FROM ownable_records
           WHERE cid = $1
         )
       ) wallet_events
       ORDER BY "blockNumber"::numeric ASC, "transactionIndex" ASC, "logIndex" ASC`,
      [cid],
    );

    return result.rows;
  }
}
