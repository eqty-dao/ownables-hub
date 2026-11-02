import { Injectable } from '@nestjs/common';
import { PostgresService } from '../postgres.service';
import type { PoolClient } from 'pg';

export interface OwnableRecordInput {
  packageCid: string;
  prevOwnerAddress: string;
  subjectId?: string;
  chainFileName?: string;
}

export interface OwnableRecord {
  id: string;
  packageCid: string;
  prevOwnerAddress: string;
  subjectId: string | null;
  ownableId?: string | null;
  chainStorageKey?: string | null;
}

export type QuarantineStatus = 'pending' | 'promoting' | 'available' | 'rejected' | 'expired';

export interface QuarantinedOwnableUpload {
  id: string;
  ownableId: string;
  subjectId: string;
  packageCid: string;
  uploadDigest: string;
  compressedBytes: string;
  expandedBytes: string;
  privateObjectKey: string;
  privateObjectDeletedAt?: string | null;
  eventChainDigest: string;
  previousOwnerAddress: string;
  status: QuarantineStatus;
  expiresAt: string;
  promotionLeaseOwner: string | null;
  promotionLeaseExpiresAt: string | null;
  reasonCode: string | null;
  reasonDetail: string | null;
  createdAt: string;
}

export interface QuarantineUploadInput {
  ownableId: string;
  subjectId: string;
  packageCid: string;
  uploadDigest: string;
  compressedBytes: number;
  expandedBytes: number;
  privateObjectKey: string;
  eventChainDigest: string;
  previousOwnerAddress: string;
  retentionSeconds: number;
  maxPendingObjects: number;
  maxPendingBytes: number;
}

export interface AvailableOwnableTransition {
  recordId: string;
  ownerAccount: string | null;
  ownerStateVersion: number;
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

export interface IndexedEventIdentity {
  slotName: string;
  chainId: string;
  anchorContractAddress: string;
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
  ownableIdentity: string | null;
  chainStorageKey: string | null;
}

@Injectable()
export class HubStateRepository {
  constructor(private readonly db: PostgresService) {}

  async upsertOwnableRecord(input: OwnableRecordInput): Promise<OwnableRecord> {
    const values = [
      input.packageCid,
      input.prevOwnerAddress,
      input.subjectId ?? null,
      input.chainFileName ?? 'eventChain.json',
    ];
    const sql =
      input.subjectId != null
        ? `INSERT INTO ownable_records (
             package_cid,
             prev_owner_address,
             subject_id,
             chain_file_name
           ) VALUES ($1, LOWER($2), LOWER($3), $4)
           ON CONFLICT (subject_id) WHERE subject_id IS NOT NULL DO UPDATE SET
             package_cid = EXCLUDED.package_cid,
             prev_owner_address = EXCLUDED.prev_owner_address,
             chain_file_name = EXCLUDED.chain_file_name,
             updated_at = NOW()
           RETURNING id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId"`
        : `INSERT INTO ownable_records (
             package_cid,
             prev_owner_address,
             subject_id,
             chain_file_name
           ) VALUES ($1, LOWER($2), LOWER($3), $4)
           RETURNING id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId"`;

    const result = await this.db.query<OwnableRecord>(sql, values);

    return result.rows[0] as OwnableRecord;
  }

  async getOwnableByCid(cid: string): Promise<OwnableRecord | null> {
    const result = await this.db.query<OwnableRecord>(
      `SELECT id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", ownable_identity AS "ownableId", chain_storage_key AS "chainStorageKey"
       FROM ownable_records
       WHERE package_cid = $1
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [cid],
    );

    return result.rows[0] ?? null;
  }

  async getOwnableBySubjectId(subjectId: string): Promise<OwnableRecord | null> {
    const result = await this.db.query<OwnableRecord>(
      `SELECT id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", ownable_identity AS "ownableId", chain_storage_key AS "chainStorageKey"
       FROM ownable_records
       WHERE subject_id = LOWER($1)
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [subjectId],
    );

    return result.rows[0] ?? null;
  }

  async getOwnableByUploadDigest(uploadDigest: string): Promise<OwnableRecord | null> {
    const result = await this.db.query<OwnableRecord>(
      `SELECT id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", ownable_identity AS "ownableId", chain_storage_key AS "chainStorageKey"
       FROM ownable_records WHERE upload_digest = $1 ORDER BY updated_at DESC LIMIT 1`,
      [uploadDigest],
    );
    return result.rows[0] ?? null;
  }

  async findActiveQuarantineByDigest(uploadDigest: string): Promise<QuarantinedOwnableUpload | null> {
    const result = await this.db.query<QuarantinedOwnableUpload>(
      `SELECT id, ownable_identity AS "ownableId", subject_id AS "subjectId", package_cid AS "packageCid",
              upload_digest AS "uploadDigest", compressed_bytes::text AS "compressedBytes",
              expanded_bytes::text AS "expandedBytes", private_object_key AS "privateObjectKey",
              event_chain_digest AS "eventChainDigest", previous_owner_address AS "previousOwnerAddress",
              status, expires_at::text AS "expiresAt", promotion_lease_owner AS "promotionLeaseOwner",
              promotion_lease_expires_at::text AS "promotionLeaseExpiresAt", reason_code AS "reasonCode",
              reason_detail AS "reasonDetail", created_at::text AS "createdAt"
       FROM quarantined_ownable_uploads
       WHERE upload_digest = $1 AND status IN ('pending', 'promoting')
       ORDER BY created_at ASC LIMIT 1`,
      [uploadDigest],
    );
    return result.rows[0] ?? null;
  }

  async findActiveQuarantineBySubjectId(subjectId: string): Promise<QuarantinedOwnableUpload | null> {
    const result = await this.db.query<QuarantinedOwnableUpload>(
      `SELECT id, ownable_identity AS "ownableId", subject_id AS "subjectId", package_cid AS "packageCid",
              upload_digest AS "uploadDigest", compressed_bytes::text AS "compressedBytes",
              expanded_bytes::text AS "expandedBytes", private_object_key AS "privateObjectKey",
              event_chain_digest AS "eventChainDigest", previous_owner_address AS "previousOwnerAddress",
              status, expires_at::text AS "expiresAt", promotion_lease_owner AS "promotionLeaseOwner",
              promotion_lease_expires_at::text AS "promotionLeaseExpiresAt", reason_code AS "reasonCode",
              reason_detail AS "reasonDetail", created_at::text AS "createdAt"
       FROM quarantined_ownable_uploads
       WHERE subject_id = LOWER($1) AND status IN ('pending', 'promoting')
       ORDER BY created_at ASC LIMIT 1`,
      [subjectId],
    );
    return result.rows[0] ?? null;
  }

  async createQuarantinedUpload(input: QuarantineUploadInput): Promise<QuarantinedOwnableUpload> {
    return this.db.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ownables-quarantine-capacity'))");
        await client.query(
          "UPDATE quarantined_ownable_uploads SET status = 'expired', updated_at = NOW(), reason_code = COALESCE(reason_code, 'EXPIRED') WHERE status IN ('pending', 'promoting') AND expires_at <= NOW()",
        );
        const capacity = await client.query<{ objects: string; bytes: string }>(
          `SELECT COUNT(*)::text AS objects, COALESCE(SUM(compressed_bytes), 0)::text AS bytes
           FROM quarantined_ownable_uploads WHERE status IN ('pending', 'promoting')`,
        );
        const current = capacity.rows[0] ?? { objects: '0', bytes: '0' };
        if (Number(current.objects) >= input.maxPendingObjects || Number(current.bytes) + input.compressedBytes > input.maxPendingBytes) {
          throw new Error('QUARANTINE_CAPACITY_EXHAUSTED');
        }
        const result = await client.query<QuarantinedOwnableUpload>(
          `INSERT INTO quarantined_ownable_uploads (
             ownable_identity, subject_id, package_cid, upload_digest, compressed_bytes, expanded_bytes,
             private_object_key, event_chain_digest, previous_owner_address, status, expires_at
           ) VALUES ($1, LOWER($2), $3, $4, $5, $6, $7, $8, LOWER($9), 'pending', NOW() + ($10::text || ' seconds')::interval)
           RETURNING id, ownable_identity AS "ownableId", subject_id AS "subjectId", package_cid AS "packageCid",
             upload_digest AS "uploadDigest", compressed_bytes::text AS "compressedBytes", expanded_bytes::text AS "expandedBytes",
             private_object_key AS "privateObjectKey", event_chain_digest AS "eventChainDigest",
             previous_owner_address AS "previousOwnerAddress", status, expires_at::text AS "expiresAt",
             promotion_lease_owner AS "promotionLeaseOwner", promotion_lease_expires_at::text AS "promotionLeaseExpiresAt",
             reason_code AS "reasonCode", reason_detail AS "reasonDetail", created_at::text AS "createdAt"`,
          [
            input.ownableId,
            input.subjectId,
            input.packageCid,
            input.uploadDigest,
            input.compressedBytes,
            input.expandedBytes,
            input.privateObjectKey,
            input.eventChainDigest,
            input.previousOwnerAddress,
            input.retentionSeconds,
          ],
        );
        await client.query('COMMIT');
        return result.rows[0] as QuarantinedOwnableUpload;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async claimQuarantinedUploads(owner: string, limit: number, leaseSeconds: number): Promise<QuarantinedOwnableUpload[]> {
    const result = await this.db.query<QuarantinedOwnableUpload>(
      `WITH candidates AS (
         SELECT id FROM quarantined_ownable_uploads
         WHERE (status = 'pending' OR (status = 'promoting' AND promotion_lease_expires_at <= NOW())) AND expires_at > NOW()
         ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE quarantined_ownable_uploads q SET status = 'promoting', promotion_lease_owner = $2,
         promotion_lease_expires_at = NOW() + ($3::text || ' seconds')::interval, last_attempt_at = NOW(), updated_at = NOW()
       FROM candidates WHERE q.id = candidates.id
       RETURNING q.id, q.ownable_identity AS "ownableId", q.subject_id AS "subjectId", q.package_cid AS "packageCid",
         q.upload_digest AS "uploadDigest", q.compressed_bytes::text AS "compressedBytes", q.expanded_bytes::text AS "expandedBytes",
         q.private_object_key AS "privateObjectKey", q.event_chain_digest AS "eventChainDigest",
         q.previous_owner_address AS "previousOwnerAddress", q.status, q.expires_at::text AS "expiresAt",
         q.promotion_lease_owner AS "promotionLeaseOwner", q.promotion_lease_expires_at::text AS "promotionLeaseExpiresAt",
         q.reason_code AS "reasonCode", q.reason_detail AS "reasonDetail", q.created_at::text AS "createdAt"`,
      [limit, owner, leaseSeconds],
    );
    return result.rows;
  }

  async claimQuarantinedUpload(id: string, owner: string, leaseSeconds: number): Promise<QuarantinedOwnableUpload | null> {
    const result = await this.db.query<QuarantinedOwnableUpload>(
      `UPDATE quarantined_ownable_uploads SET status = 'promoting', promotion_lease_owner = $2,
       promotion_lease_expires_at = NOW() + ($3::text || ' seconds')::interval, last_attempt_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'pending' AND expires_at > NOW()
       RETURNING id, ownable_identity AS "ownableId", subject_id AS "subjectId", package_cid AS "packageCid",
         upload_digest AS "uploadDigest", compressed_bytes::text AS "compressedBytes", expanded_bytes::text AS "expandedBytes",
         private_object_key AS "privateObjectKey", event_chain_digest AS "eventChainDigest",
         previous_owner_address AS "previousOwnerAddress", status, expires_at::text AS "expiresAt",
         promotion_lease_owner AS "promotionLeaseOwner", promotion_lease_expires_at::text AS "promotionLeaseExpiresAt",
         reason_code AS "reasonCode", reason_detail AS "reasonDetail", created_at::text AS "createdAt"`,
      [id, owner, leaseSeconds],
    );
    return result.rows[0] ?? null;
  }

  async restoreQuarantinePending(id: string, reasonCode?: string): Promise<void> {
    await this.db.query(
      `UPDATE quarantined_ownable_uploads SET status = 'pending', promotion_lease_owner = NULL,
       promotion_lease_expires_at = NULL, reason_code = $2, updated_at = NOW() WHERE id = $1 AND status = 'promoting'`,
      [id, reasonCode ?? null],
    );
  }

  async rejectQuarantinedUpload(id: string, reasonCode: string, reasonDetail?: string): Promise<void> {
    await this.db.query(
      `UPDATE quarantined_ownable_uploads SET status = 'rejected', reason_code = $2, reason_detail = $3,
       promotion_lease_owner = NULL, promotion_lease_expires_at = NULL, updated_at = NOW() WHERE id = $1`,
      [id, reasonCode, reasonDetail ?? null],
    );
  }

  async expireQuarantinedUploads(limit: number): Promise<QuarantinedOwnableUpload[]> {
    const result = await this.db.query<QuarantinedOwnableUpload>(
      `WITH candidates AS (
         SELECT id FROM quarantined_ownable_uploads
         WHERE private_object_deleted_at IS NULL
           AND ((status IN ('pending', 'promoting') AND expires_at <= NOW()) OR status IN ('available', 'rejected', 'expired'))
         ORDER BY expires_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
       ) UPDATE quarantined_ownable_uploads q SET
         status = CASE WHEN q.status IN ('pending', 'promoting') THEN 'expired' ELSE q.status END,
         reason_code = CASE WHEN q.status IN ('pending', 'promoting') THEN 'EXPIRED' ELSE q.reason_code END,
         promotion_lease_owner = CASE WHEN q.status IN ('pending', 'promoting') THEN NULL ELSE q.promotion_lease_owner END,
         promotion_lease_expires_at = CASE WHEN q.status IN ('pending', 'promoting') THEN NULL ELSE q.promotion_lease_expires_at END,
         updated_at = NOW()
       FROM candidates WHERE q.id = candidates.id
       RETURNING q.id, q.private_object_key AS "privateObjectKey", q.status, q.ownable_identity AS "ownableId",
         q.subject_id AS "subjectId", q.package_cid AS "packageCid", q.upload_digest AS "uploadDigest",
         q.compressed_bytes::text AS "compressedBytes", q.expanded_bytes::text AS "expandedBytes",
         q.event_chain_digest AS "eventChainDigest", q.previous_owner_address AS "previousOwnerAddress",
         q.expires_at::text AS "expiresAt", q.promotion_lease_owner AS "promotionLeaseOwner",
         q.promotion_lease_expires_at::text AS "promotionLeaseExpiresAt", q.reason_code AS "reasonCode",
         q.reason_detail AS "reasonDetail", q.created_at::text AS "createdAt"`,
      [limit],
    );
    return result.rows;
  }

  async privateObjectIsReferenced(key: string): Promise<boolean> {
    const result = await this.db.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM quarantined_ownable_uploads WHERE private_object_key = $1 AND status IN ('pending', 'promoting')) AS present",
      [key],
    );
    return result.rows[0]?.present ?? false;
  }

  async markPrivateObjectDeleted(id: string): Promise<void> {
    await this.db.query(
      'UPDATE quarantined_ownable_uploads SET private_object_deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND private_object_deleted_at IS NULL',
      [id],
    );
  }

  async publishQuarantinedUpload(input: {
    quarantineId: string;
    ownableId: string;
    packageCid: string;
    uploadDigest: string;
    previousOwnerAddress: string;
    subjectId: string;
    chainStorageKey: string;
    owner: string;
    ownerAccount: string | null;
    latestAppliedPublicEventId: string | null;
    notification: unknown;
  }): Promise<AvailableOwnableTransition> {
    return this.db.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const candidate = await client.query<{ id: string }>(
          `SELECT id FROM quarantined_ownable_uploads
           WHERE id = $1 AND status = 'promoting' AND expires_at > NOW() FOR UPDATE`,
          [input.quarantineId],
        );
        if (!candidate.rows[0]) {
          throw new Error('QUARANTINE_UPLOAD_NOT_PROMOTABLE');
        }
        const recordResult = await client.query<OwnableRecord>(
          `INSERT INTO ownable_records (package_cid, prev_owner_address, subject_id, chain_file_name, upload_digest, chain_storage_key, ownable_identity)
           VALUES ($1, LOWER($2), LOWER($3), 'chain.json', $4, $5, $6)
           ON CONFLICT (subject_id) WHERE subject_id IS NOT NULL DO UPDATE SET package_cid = EXCLUDED.package_cid,
             prev_owner_address = EXCLUDED.prev_owner_address, chain_file_name = EXCLUDED.chain_file_name,
             upload_digest = EXCLUDED.upload_digest, chain_storage_key = EXCLUDED.chain_storage_key,
             ownable_identity = EXCLUDED.ownable_identity, updated_at = NOW()
           RETURNING id, package_cid AS "packageCid", prev_owner_address AS "prevOwnerAddress", subject_id AS "subjectId", ownable_identity AS "ownableId", chain_storage_key AS "chainStorageKey"`,
          [input.packageCid, input.previousOwnerAddress, input.subjectId, input.uploadDigest, input.chainStorageKey, input.ownableId],
        );
        const record = recordResult.rows[0] as OwnableRecord;
        const ownerState = await client.query<{ version: number }>(
          `INSERT INTO ownable_owner_state (ownable_id, current_owner_address, current_owner_account, last_applied_public_event_id, owner_state_version)
           VALUES ($1, LOWER($2), $3, $4, 1)
           ON CONFLICT (ownable_id) DO UPDATE SET current_owner_address = EXCLUDED.current_owner_address,
             current_owner_account = EXCLUDED.current_owner_account, last_applied_public_event_id = EXCLUDED.last_applied_public_event_id,
             owner_state_version = CASE WHEN ownable_owner_state.current_owner_address IS DISTINCT FROM EXCLUDED.current_owner_address
               OR ownable_owner_state.current_owner_account IS DISTINCT FROM EXCLUDED.current_owner_account
               OR ownable_owner_state.last_applied_public_event_id IS DISTINCT FROM EXCLUDED.last_applied_public_event_id
               THEN ownable_owner_state.owner_state_version + 1 ELSE ownable_owner_state.owner_state_version END,
             updated_at = NOW()
           RETURNING owner_state_version AS version`,
          [record.id, input.owner, input.ownerAccount, input.latestAppliedPublicEventId],
        );
        await client.query(
          `UPDATE quarantined_ownable_uploads SET status = 'available', promotion_lease_owner = NULL,
           promotion_lease_expires_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'promoting'`,
          [input.quarantineId],
        );
        const version = ownerState.rows[0]?.version ?? 1;
        await client.query('SELECT pg_notify($1, $2)', [
          'ownables_available_ownables',
          JSON.stringify({ transition: { recordId: record.id, ownerAccount: input.ownerAccount, ownerStateVersion: version }, notification: input.notification }),
        ]);
        await client.query('COMMIT');
        return { recordId: record.id, ownerAccount: input.ownerAccount, ownerStateVersion: version };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async acquireIngressLease(input: { concurrency: number; rateWindowSeconds: number; rateMaxRequests: number; leaseSeconds: number }): Promise<string> {
    return this.db.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ownables-quarantine-ingress'))");
        await client.query('DELETE FROM quarantine_ingress_leases WHERE expires_at <= NOW()');
        await client.query("DELETE FROM quarantine_request_windows WHERE requested_at <= NOW() - ($1::text || ' seconds')::interval", [input.rateWindowSeconds]);
        const [leases, requests] = await Promise.all([
          client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM quarantine_ingress_leases'),
          client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM quarantine_request_windows'),
        ]);
        if (Number(requests.rows[0]?.count ?? 0) >= input.rateMaxRequests) throw new Error('UPLOAD_RATE_LIMITED');
        if (Number(leases.rows[0]?.count ?? 0) >= input.concurrency) throw new Error('QUARANTINE_CAPACITY_EXHAUSTED');
        await client.query('INSERT INTO quarantine_request_windows DEFAULT VALUES');
        const inserted = await client.query<{ id: string }>(
          "INSERT INTO quarantine_ingress_leases (expires_at) VALUES (NOW() + ($1::text || ' seconds')::interval) RETURNING id",
          [input.leaseSeconds],
        );
        await client.query('COMMIT');
        return inserted.rows[0]?.id as string;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async releaseIngressLease(id: string): Promise<void> {
    await this.db.query('DELETE FROM quarantine_ingress_leases WHERE id = $1', [id]);
  }

  async acquireProcessingLease(input: {
    concurrency: number;
    reservedBytes: number;
    maxReservedBytes: number;
    leaseSeconds: number;
  }): Promise<string> {
    return this.db.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ownables-quarantine-processing'))");
        await client.query('DELETE FROM quarantine_processing_leases WHERE expires_at <= NOW()');
        const usage = await client.query<{ count: string; bytes: string }>(
          'SELECT COUNT(*)::text AS count, COALESCE(SUM(reserved_bytes), 0)::text AS bytes FROM quarantine_processing_leases',
        );
        const current = usage.rows[0] ?? { count: '0', bytes: '0' };
        if (Number(current.count) >= input.concurrency || Number(current.bytes) + input.reservedBytes > input.maxReservedBytes) {
          throw new Error('QUARANTINE_CAPACITY_EXHAUSTED');
        }
        const inserted = await client.query<{ id: string }>(
          "INSERT INTO quarantine_processing_leases (reserved_bytes, expires_at) VALUES ($1, NOW() + ($2::text || ' seconds')::interval) RETURNING id",
          [input.reservedBytes, input.leaseSeconds],
        );
        await client.query('COMMIT');
        return inserted.rows[0]?.id as string;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async releaseProcessingLease(id: string): Promise<void> {
    await this.db.query('DELETE FROM quarantine_processing_leases WHERE id = $1', [id]);
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
         o.ownable_identity AS "ownableIdentity",
         o.chain_storage_key AS "chainStorageKey"
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

  async listIndexedPublicEventsBySubjectId(
    subjectId: string,
    identity: IndexedEventIdentity,
  ): Promise<IndexedPublicEventRow[]> {
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
         AND slot_name = $2
         AND chain_id = $3
         AND LOWER(anchor_contract_address) = LOWER($4)
       ORDER BY block_number ASC, transaction_index ASC, log_index ASC`,
      [subjectId, identity.slotName, identity.chainId, identity.anchorContractAddress],
    );

    return result.rows;
  }

  async listIndexedPublicEventsBySubjectIdsAfter(
    subjectIds: string[],
    fromBlock: bigint,
    cursor: IndexedPublicEventCursor | null,
    identity: IndexedEventIdentity,
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
         AND slot_name = $6
         AND chain_id = $7
         AND LOWER(anchor_contract_address) = LOWER($8)
       ORDER BY block_number ASC, transaction_index ASC, log_index ASC`,
      [
        normalizedSubjectIds,
        fromBlock.toString(),
        cursor ? cursor.blockNumber.toString() : null,
        cursor?.transactionIndex ?? null,
        cursor?.logIndex ?? null,
        identity.slotName,
        identity.chainId,
        identity.anchorContractAddress,
      ],
    );

    return result.rows;
  }
}
