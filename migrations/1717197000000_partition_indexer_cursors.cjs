/* eslint-disable camelcase */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Existing cursor rows are retained, but addresses become canonical identity values.
  pgm.sql('UPDATE indexer_cursors SET anchor_contract_address = LOWER(anchor_contract_address)');
  pgm.dropConstraint('indexer_cursors', 'indexer_cursors_slot_cursor_unique');
  pgm.addConstraint('indexer_cursors', 'indexer_cursors_identity_unique', {
    unique: ['slot_name', 'cursor_name', 'chain_id', 'anchor_contract_address'],
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  // Restore the old one-row-per-slot/name contract deterministically before adding it.
  pgm.sql(`
    DELETE FROM indexer_cursors older
    USING indexer_cursors newer
    WHERE older.slot_name = newer.slot_name
      AND older.cursor_name = newer.cursor_name
      AND (
        older.updated_at < newer.updated_at
        OR (older.updated_at = newer.updated_at AND older.anchor_contract_address > newer.anchor_contract_address)
      )
  `);
  pgm.dropConstraint('indexer_cursors', 'indexer_cursors_identity_unique');
  pgm.addConstraint('indexer_cursors', 'indexer_cursors_slot_cursor_unique', {
    unique: ['slot_name', 'cursor_name'],
  });
};
