/* eslint-disable camelcase */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('indexed_anchor_events', {
    transaction_index: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addColumn('indexed_public_events', {
    transaction_index: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addColumn('indexer_cursors', {
    last_scanned_tx_index: { type: 'integer' },
  });

  pgm.dropIndex('indexed_anchor_events', ['slot_name', 'block_number', 'log_index']);
  pgm.dropIndex('indexed_public_events', ['slot_name', 'block_number', 'log_index']);
  pgm.createIndex('indexed_anchor_events', ['slot_name', 'block_number', 'transaction_index', 'log_index']);
  pgm.createIndex('indexed_public_events', ['slot_name', 'block_number', 'transaction_index', 'log_index']);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('indexed_public_events', ['slot_name', 'block_number', 'transaction_index', 'log_index']);
  pgm.dropIndex('indexed_anchor_events', ['slot_name', 'block_number', 'transaction_index', 'log_index']);
  pgm.createIndex('indexed_anchor_events', ['slot_name', 'block_number', 'log_index']);
  pgm.createIndex('indexed_public_events', ['slot_name', 'block_number', 'log_index']);

  pgm.dropColumn('indexer_cursors', 'last_scanned_tx_index');
  pgm.dropColumn('indexed_public_events', 'transaction_index');
  pgm.dropColumn('indexed_anchor_events', 'transaction_index');
};
