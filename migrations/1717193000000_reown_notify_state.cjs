/* eslint-disable camelcase */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.dropTable('notify_delivery_state');
  pgm.dropTable('notify_registrations');

  pgm.createTable('notify_delivery_state', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    ownable_id: { type: 'uuid', notNull: true, references: 'ownable_records', onDelete: 'CASCADE' },
    owner_address: { type: 'text', notNull: true },
    owner_account: { type: 'text', notNull: true },
    owner_state_version: { type: 'integer', notNull: true },
    trigger_kind: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    notification_type: { type: 'text' },
    notification_id: { type: 'text' },
    transport_id: { type: 'text' },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    last_attempt_at: { type: 'timestamptz' },
    delivered_at: { type: 'timestamptz' },
    error_code: { type: 'text' },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('notify_delivery_state', 'notify_delivery_state_account_dedupe_unique', {
    unique: ['ownable_id', 'owner_account', 'owner_state_version', 'trigger_kind'],
  });
  pgm.createIndex('notify_delivery_state', ['owner_account', 'status']);
  pgm.createIndex('notify_delivery_state', ['ownable_id', 'owner_account']);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('notify_delivery_state');

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
};
