/* eslint-disable camelcase */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('ownable_owner_state', {
    current_owner_account: { type: 'text' },
  });
  pgm.createIndex('ownable_owner_state', 'current_owner_account');

  pgm.sql(`
    UPDATE ownable_owner_state os
    SET current_owner_account = backfill.owner_account
    FROM (
      SELECT DISTINCT ON (ownable_id, owner_state_version)
        ownable_id,
        owner_state_version,
        owner_account
      FROM notify_delivery_state
      WHERE owner_account IS NOT NULL
        AND owner_account NOT LIKE 'unknown:%'
      ORDER BY ownable_id, owner_state_version, last_attempt_at DESC NULLS LAST, created_at DESC
    ) backfill
    WHERE backfill.ownable_id = os.ownable_id
      AND backfill.owner_state_version = os.owner_state_version
      AND os.current_owner_account IS NULL
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('ownable_owner_state', 'current_owner_account');
  pgm.dropColumns('ownable_owner_state', ['current_owner_account']);
};
