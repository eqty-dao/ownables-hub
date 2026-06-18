/* eslint-disable camelcase */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('ownable_records', {
    subject_id: { type: 'text' },
  });
  pgm.createIndex('ownable_records', 'subject_id', {
    unique: true,
    where: 'subject_id IS NOT NULL',
    name: 'ownable_records_subject_id_unique',
  });

  pgm.dropTable('indexed_public_events');
  pgm.createTable('indexed_public_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    slot_name: { type: 'text', notNull: true },
    chain_id: { type: 'text', notNull: true },
    anchor_contract_address: { type: 'text', notNull: true },
    block_number: { type: 'bigint', notNull: true },
    block_hash: { type: 'text', notNull: true },
    transaction_hash: { type: 'text', notNull: true },
    transaction_index: { type: 'integer', notNull: true, default: 0 },
    log_index: { type: 'integer', notNull: true },
    event_name: { type: 'text', notNull: true },
    ownable_id: { type: 'uuid', references: 'ownable_records', onDelete: 'SET NULL' },
    cid: { type: 'text' },
    subject_id: { type: 'text', notNull: true },
    source_address: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    data_hex: { type: 'text', notNull: true },
    event_timestamp: { type: 'bigint', notNull: true },
    payload_json: { type: 'jsonb', notNull: true },
    indexed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('indexed_public_events', 'indexed_public_events_unique_slot_tx_log', {
    unique: ['slot_name', 'transaction_hash', 'log_index'],
  });
  pgm.createIndex('indexed_public_events', ['slot_name', 'block_number', 'transaction_index', 'log_index']);
  pgm.createIndex('indexed_public_events', 'cid');
  pgm.createIndex('indexed_public_events', 'subject_id');
  pgm.createIndex('indexed_public_events', ['subject_id', 'block_number', 'transaction_index', 'log_index']);

  // Local cursor state is disposable for this shape remediation: force historical reindex.
  pgm.sql("DELETE FROM indexer_cursors WHERE cursor_name = 'anchor-public-events'");
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('indexed_public_events');
  pgm.createTable('indexed_public_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    slot_name: { type: 'text', notNull: true },
    chain_id: { type: 'text', notNull: true },
    anchor_contract_address: { type: 'text', notNull: true },
    block_number: { type: 'bigint', notNull: true },
    block_hash: { type: 'text', notNull: true },
    transaction_hash: { type: 'text', notNull: true },
    transaction_index: { type: 'integer', notNull: true, default: 0 },
    log_index: { type: 'integer', notNull: true },
    event_name: { type: 'text', notNull: true },
    cid: { type: 'text' },
    ownable_id: { type: 'uuid', references: 'ownable_records', onDelete: 'SET NULL' },
    owner_address: { type: 'text' },
    payload_json: { type: 'jsonb', notNull: true },
    indexed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('indexed_public_events', 'indexed_public_events_unique_slot_tx_log', {
    unique: ['slot_name', 'transaction_hash', 'log_index'],
  });
  pgm.createIndex('indexed_public_events', ['slot_name', 'block_number', 'transaction_index', 'log_index']);
  pgm.createIndex('indexed_public_events', 'cid');
  pgm.createIndex('indexed_public_events', 'owner_address');

  pgm.dropIndex('ownable_records', 'subject_id', {
    name: 'ownable_records_subject_id_unique',
    ifExists: true,
  });
  pgm.dropColumn('ownable_records', 'subject_id');
};
