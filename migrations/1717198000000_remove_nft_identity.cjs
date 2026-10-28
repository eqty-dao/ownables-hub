/* eslint-disable camelcase */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.dropConstraint('ownable_records', 'ownable_records_nft_unique');
  pgm.dropColumns('ownable_records', ['nft_network', 'nft_contract_address', 'nft_token_id']);
};

/**
 * Restores the schema only. Values removed by the up migration are not recoverable.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.addColumns('ownable_records', {
    nft_network: { type: 'text' },
    nft_contract_address: { type: 'text' },
    nft_token_id: { type: 'text' },
  });
  pgm.addConstraint('ownable_records', 'ownable_records_nft_unique', {
    unique: ['nft_network', 'nft_contract_address', 'nft_token_id'],
    where: 'nft_network IS NOT NULL AND nft_contract_address IS NOT NULL AND nft_token_id IS NOT NULL',
  });
};
