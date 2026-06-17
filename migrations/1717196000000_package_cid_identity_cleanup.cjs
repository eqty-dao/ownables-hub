/* eslint-disable camelcase */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.renameColumn('ownable_records', 'cid', 'package_cid');
  pgm.renameColumn('indexed_anchor_events', 'cid', 'package_cid');
  pgm.renameColumn('indexed_public_events', 'cid', 'package_cid');

  pgm.dropConstraint('ownable_records', 'ownable_records_cid_key', { ifExists: true });
  pgm.createIndex('ownable_records', 'package_cid', {
    name: 'ownable_records_package_cid_idx',
    ifNotExists: true,
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('ownable_records', 'package_cid', {
    name: 'ownable_records_package_cid_idx',
    ifExists: true,
  });
  pgm.addConstraint('ownable_records', 'ownable_records_cid_key', {
    unique: ['package_cid'],
  });

  pgm.renameColumn('indexed_public_events', 'package_cid', 'cid');
  pgm.renameColumn('indexed_anchor_events', 'package_cid', 'cid');
  pgm.renameColumn('ownable_records', 'package_cid', 'cid');
};
