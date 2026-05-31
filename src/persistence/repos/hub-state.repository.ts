import { Injectable } from '@nestjs/common';
import { PostgresService } from '../postgres.service.js';

export interface OwnableRecordInput {
  cid: string;
  prevOwnerAddress: string;
  nftNetwork?: string;
  nftContractAddress?: string;
  nftTokenId?: string;
  chainFileName?: string;
}

export interface OwnableRecord {
  id: string;
  cid: string;
  prevOwnerAddress: string;
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
  logIndex: number;
  eventName: string;
  cid: string | null;
  ownableId: string | null;
  ownerAddress: string | null;
  payloadJson: unknown;
  indexedAt: string;
}

@Injectable()
export class HubStateRepository {
  constructor(private readonly db: PostgresService) {}

  async upsertOwnableRecord(input: OwnableRecordInput): Promise<OwnableRecord> {
    const result = await this.db.query<OwnableRecord>(
      `INSERT INTO ownable_records (
         cid,
         prev_owner_address,
         nft_network,
         nft_contract_address,
         nft_token_id,
         chain_file_name
       ) VALUES ($1, LOWER($2), $3, $4, $5, $6)
       ON CONFLICT (cid) DO UPDATE SET
         prev_owner_address = EXCLUDED.prev_owner_address,
         nft_network = EXCLUDED.nft_network,
         nft_contract_address = EXCLUDED.nft_contract_address,
         nft_token_id = EXCLUDED.nft_token_id,
         chain_file_name = EXCLUDED.chain_file_name,
         updated_at = NOW()
       RETURNING id, cid, prev_owner_address AS "prevOwnerAddress", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"`,
      [
        input.cid,
        input.prevOwnerAddress,
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
      `SELECT id, cid, prev_owner_address AS "prevOwnerAddress", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"
       FROM ownable_records WHERE cid = $1`,
      [cid],
    );

    return result.rows[0] ?? null;
  }

  async getOwnableByNft(nftNetwork: string, nftContractAddress: string, nftTokenId: string): Promise<OwnableRecord | null> {
    const result = await this.db.query<OwnableRecord>(
      `SELECT id, cid, prev_owner_address AS "prevOwnerAddress", nft_network AS "nftNetwork", nft_contract_address AS "nftContractAddress", nft_token_id AS "nftTokenId"
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

  async getOwnerStateByCid(cid: string): Promise<{ owner: string; version: number } | null> {
    const result = await this.db.query<{ owner: string; version: number }>(
      `SELECT s.current_owner_address AS owner, s.owner_state_version AS version
       FROM ownable_owner_state s
       INNER JOIN ownable_records o ON o.id = s.ownable_id
       WHERE o.cid = $1`,
      [cid],
    );

    return result.rows[0] ?? null;
  }

  async upsertIndexerCursor(input: {
    slotName: 'testnet' | 'mainnet';
    cursorName: string;
    chainId: string;
    anchorContractAddress: string;
    nextFromBlock: bigint;
    lastScannedBlock?: bigint | null;
    lastScannedTxHash?: string | null;
    lastScannedLogIndex?: number | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO indexer_cursors (
         slot_name,
         cursor_name,
         chain_id,
         anchor_contract_address,
         next_from_block,
         last_scanned_block,
         last_scanned_tx_hash,
         last_scanned_log_index
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (slot_name, cursor_name) DO UPDATE SET
         chain_id = EXCLUDED.chain_id,
         anchor_contract_address = EXCLUDED.anchor_contract_address,
         next_from_block = EXCLUDED.next_from_block,
         last_scanned_block = EXCLUDED.last_scanned_block,
         last_scanned_tx_hash = EXCLUDED.last_scanned_tx_hash,
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
        input.lastScannedLogIndex ?? null,
      ],
    );
  }

  async upsertNotifyRegistration(input: {
    ownerAddress: string;
    ownerAccount: string;
    topic: string;
    status?: 'active' | 'stale' | 'replaced';
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO notify_registrations (owner_address, owner_account, topic, status, last_seen_at)
       VALUES (LOWER($1), $2, $3, $4, NOW())
       ON CONFLICT (owner_address, topic) DO UPDATE SET
         owner_account = EXCLUDED.owner_account,
         status = EXCLUDED.status,
         last_seen_at = NOW(),
         updated_at = NOW()`,
      [input.ownerAddress, input.ownerAccount, input.topic, input.status ?? 'active'],
    );
  }

  async upsertNotifyDeliveryState(input: {
    registrationId: string;
    ownableId: string;
    ownerStateVersion: number;
    triggerKind: string;
    status?: string;
    attemptCount?: number;
    lastError?: string | null;
  }): Promise<void> {
    await this.db.query(
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
         delivered_at = CASE WHEN EXCLUDED.status = 'delivered' THEN NOW() ELSE notify_delivery_state.delivered_at END`,
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
  }

  async upsertIndexedAnchorEvent(input: {
    slotName: string;
    chainId: string;
    anchorContractAddress: string;
    blockNumber: bigint;
    blockHash: string;
    transactionHash: string;
    logIndex: number;
    eventName: string;
    cid?: string | null;
    ownableId?: string | null;
    ownerAddress?: string | null;
    payloadJson: unknown;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO indexed_anchor_events (
         slot_name,
         chain_id,
         anchor_contract_address,
         block_number,
         block_hash,
         transaction_hash,
         log_index,
         event_name,
         cid,
         ownable_id,
         owner_address,
         payload_json
       ) VALUES ($1, $2, LOWER($3), $4, LOWER($5), LOWER($6), $7, $8, $9, $10, LOWER($11), $12::jsonb)
       ON CONFLICT (slot_name, transaction_hash, log_index) DO UPDATE SET
         chain_id = EXCLUDED.chain_id,
         anchor_contract_address = EXCLUDED.anchor_contract_address,
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
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
        input.logIndex,
        input.eventName,
        input.cid ?? null,
        input.ownableId ?? null,
        input.ownerAddress ?? null,
        JSON.stringify(input.payloadJson),
      ],
    );
  }

  async upsertIndexedPublicEvent(input: {
    slotName: string;
    chainId: string;
    anchorContractAddress: string;
    blockNumber: bigint;
    blockHash: string;
    transactionHash: string;
    logIndex: number;
    eventName: string;
    cid?: string | null;
    ownableId?: string | null;
    ownerAddress?: string | null;
    payloadJson: unknown;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO indexed_public_events (
         slot_name,
         chain_id,
         anchor_contract_address,
         block_number,
         block_hash,
         transaction_hash,
         log_index,
         event_name,
         cid,
         ownable_id,
         owner_address,
         payload_json
       ) VALUES ($1, $2, LOWER($3), $4, LOWER($5), LOWER($6), $7, $8, $9, $10, LOWER($11), $12::jsonb)
       ON CONFLICT (slot_name, transaction_hash, log_index) DO UPDATE SET
         chain_id = EXCLUDED.chain_id,
         anchor_contract_address = EXCLUDED.anchor_contract_address,
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
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
        input.logIndex,
        input.eventName,
        input.cid ?? null,
        input.ownableId ?? null,
        input.ownerAddress ?? null,
        JSON.stringify(input.payloadJson),
      ],
    );
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
           log_index AS "logIndex",
           event_name AS "eventName",
           cid,
           ownable_id AS "ownableId",
           owner_address AS "ownerAddress",
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
           log_index AS "logIndex",
           event_name AS "eventName",
           cid,
           ownable_id AS "ownableId",
           owner_address AS "ownerAddress",
           payload_json AS "payloadJson",
           indexed_at::text AS "indexedAt"
         FROM indexed_public_events
         WHERE cid = $1
       ) wallet_events
       ORDER BY "blockNumber"::numeric ASC, "logIndex" ASC`,
      [cid],
    );

    return result.rows;
  }
}
