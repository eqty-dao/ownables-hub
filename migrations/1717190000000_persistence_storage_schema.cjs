/* eslint-disable camelcase */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  pgm.createTable('ownable_records', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    cid: { type: 'text', notNull: true, unique: true },
    prev_owner_address: { type: 'text', notNull: true },
    nft_network: { type: 'text' },
    nft_contract_address: { type: 'text' },
    nft_token_id: { type: 'text' },
    chain_file_name: { type: 'text', notNull: true, default: 'eventChain.json' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('ownable_records', 'ownable_records_nft_unique', {
    unique: ['nft_network', 'nft_contract_address', 'nft_token_id'],
    where: 'nft_network IS NOT NULL AND nft_contract_address IS NOT NULL AND nft_token_id IS NOT NULL',
  });
  pgm.createIndex('ownable_records', 'prev_owner_address');

  pgm.createTable('ownable_owner_state', {
    ownable_id: { type: 'uuid', primaryKey: true, references: 'ownable_records', onDelete: 'CASCADE' },
    current_owner_address: { type: 'text', notNull: true },
    last_applied_public_event_id: { type: 'uuid' },
    owner_state_version: { type: 'integer', notNull: true, default: 1 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ownable_owner_state', 'current_owner_address');

  pgm.createTable('indexed_anchor_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    slot_name: { type: 'text', notNull: true },
    chain_id: { type: 'text', notNull: true },
    anchor_contract_address: { type: 'text', notNull: true },
    block_number: { type: 'bigint', notNull: true },
    block_hash: { type: 'text', notNull: true },
    transaction_hash: { type: 'text', notNull: true },
    log_index: { type: 'integer', notNull: true },
    event_name: { type: 'text', notNull: true },
    cid: { type: 'text' },
    ownable_id: { type: 'uuid', references: 'ownable_records', onDelete: 'SET NULL' },
    owner_address: { type: 'text' },
    payload_json: { type: 'jsonb', notNull: true },
    indexed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('indexed_anchor_events', 'indexed_anchor_events_unique_slot_tx_log', {
    unique: ['slot_name', 'transaction_hash', 'log_index'],
  });
  pgm.createIndex('indexed_anchor_events', ['slot_name', 'block_number', 'log_index']);
  pgm.createIndex('indexed_anchor_events', 'cid');
  pgm.createIndex('indexed_anchor_events', 'owner_address');

  pgm.createTable('indexed_public_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    slot_name: { type: 'text', notNull: true },
    chain_id: { type: 'text', notNull: true },
    anchor_contract_address: { type: 'text', notNull: true },
    block_number: { type: 'bigint', notNull: true },
    block_hash: { type: 'text', notNull: true },
    transaction_hash: { type: 'text', notNull: true },
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
  pgm.createIndex('indexed_public_events', ['slot_name', 'block_number', 'log_index']);
  pgm.createIndex('indexed_public_events', 'cid');
  pgm.createIndex('indexed_public_events', 'owner_address');

  pgm.createTable('notify_registrations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    owner_address: { type: 'text', notNull: true },
    owner_account: { type: 'text', notNull: true },
    topic: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true, default: 'active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    replaced_by_registration_id: { type: 'uuid', references: 'notify_registrations', onDelete: 'SET NULL' },
    stale_reason: { type: 'text' },
  });
  pgm.addConstraint('notify_registrations', 'notify_registrations_owner_topic_unique', {
    unique: ['owner_address', 'topic'],
  });
  pgm.createIndex('notify_registrations', ['owner_address', 'status']);

  pgm.createTable('notify_delivery_state', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    registration_id: { type: 'uuid', notNull: true, references: 'notify_registrations', onDelete: 'CASCADE' },
    ownable_id: { type: 'uuid', notNull: true, references: 'ownable_records', onDelete: 'CASCADE' },
    owner_state_version: { type: 'integer', notNull: true },
    trigger_kind: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    last_attempt_at: { type: 'timestamptz' },
    delivered_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
  });
  pgm.addConstraint('notify_delivery_state', 'notify_delivery_state_dedupe_unique', {
    unique: ['registration_id', 'ownable_id', 'owner_state_version', 'trigger_kind'],
  });
  pgm.createIndex('notify_delivery_state', ['status', 'last_attempt_at']);

  pgm.createTable('indexer_cursors', {
    slot_name: { type: 'text', notNull: true },
    cursor_name: { type: 'text', notNull: true },
    chain_id: { type: 'text', notNull: true },
    anchor_contract_address: { type: 'text', notNull: true },
    next_from_block: { type: 'bigint', notNull: true },
    last_scanned_block: { type: 'bigint' },
    last_scanned_tx_hash: { type: 'text' },
    last_scanned_log_index: { type: 'integer' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('indexer_cursors', 'indexer_cursors_slot_cursor_unique', {
    unique: ['slot_name', 'cursor_name'],
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('indexer_cursors');
  pgm.dropTable('notify_delivery_state');
  pgm.dropTable('notify_registrations');
  pgm.dropTable('indexed_public_events');
  pgm.dropTable('indexed_anchor_events');
  pgm.dropTable('ownable_owner_state');
  pgm.dropTable('ownable_records');
};
