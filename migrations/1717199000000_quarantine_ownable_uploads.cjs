/* eslint-disable camelcase */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('ownable_records', {
    upload_digest: { type: 'text' },
    chain_storage_key: { type: 'text' },
    ownable_identity: { type: 'text' },
  });
  pgm.createIndex('ownable_records', 'upload_digest', {
    name: 'ownable_records_upload_digest_idx',
    where: 'upload_digest IS NOT NULL',
  });

  pgm.createTable('quarantined_ownable_uploads', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    ownable_identity: { type: 'text', notNull: true },
    subject_id: { type: 'text', notNull: true },
    package_cid: { type: 'text', notNull: true },
    upload_digest: { type: 'text', notNull: true },
    compressed_bytes: { type: 'bigint', notNull: true },
    expanded_bytes: { type: 'bigint', notNull: true },
    private_object_key: { type: 'text', notNull: true },
    private_object_deleted_at: { type: 'timestamptz' },
    event_chain_digest: { type: 'text', notNull: true },
    previous_owner_address: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    expires_at: { type: 'timestamptz', notNull: true },
    promotion_lease_owner: { type: 'text' },
    promotion_lease_expires_at: { type: 'timestamptz' },
    reason_code: { type: 'text' },
    reason_detail: { type: 'text' },
    last_attempt_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('quarantined_ownable_uploads', 'quarantined_ownable_uploads_status_check', {
    check: "status IN ('pending', 'promoting', 'available', 'rejected', 'expired')",
  });
  pgm.addConstraint('quarantined_ownable_uploads', 'quarantined_ownable_uploads_nonnegative_bytes_check', {
    check: 'compressed_bytes >= 0 AND expanded_bytes >= 0',
  });
  pgm.createIndex('quarantined_ownable_uploads', 'upload_digest', {
    name: 'quarantine_active_upload_digest_unique',
    unique: true,
    where: "status IN ('pending', 'promoting')",
  });
  pgm.createIndex('quarantined_ownable_uploads', 'subject_id', {
    name: 'quarantine_active_subject_unique',
    unique: true,
    where: "status IN ('pending', 'promoting')",
  });
  pgm.createIndex('quarantined_ownable_uploads', ['status', 'expires_at'], {
    name: 'quarantine_status_expiry_idx',
  });
  pgm.createIndex('quarantined_ownable_uploads', 'private_object_key', {
    name: 'quarantine_private_object_key_idx',
  });

  pgm.createTable('quarantine_ingress_leases', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('quarantine_ingress_leases', 'expires_at');

  pgm.createTable('quarantine_processing_leases', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    reserved_bytes: { type: 'bigint', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('quarantine_processing_leases', 'quarantine_processing_leases_nonnegative_bytes_check', {
    check: 'reserved_bytes > 0',
  });
  pgm.createIndex('quarantine_processing_leases', 'expires_at');

  pgm.createTable('quarantine_request_windows', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    requested_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('quarantine_request_windows', 'requested_at');
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('quarantine_request_windows');
  pgm.dropTable('quarantine_processing_leases');
  pgm.dropTable('quarantine_ingress_leases');
  pgm.dropTable('quarantined_ownable_uploads');
  pgm.dropIndex('ownable_records', 'upload_digest', { name: 'ownable_records_upload_digest_idx' });
  pgm.dropColumns('ownable_records', ['upload_digest', 'chain_storage_key', 'ownable_identity']);
};
