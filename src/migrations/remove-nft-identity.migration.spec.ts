type MigrationBuilder = {
  dropConstraint: (...args: unknown[]) => void;
  dropColumns: (...args: unknown[]) => void;
  addColumns: (...args: unknown[]) => void;
  addConstraint: (...args: unknown[]) => void;
};

const migration = require('../../migrations/1717198000000_remove_nft_identity.cjs') as {
  up: (pgm: MigrationBuilder) => void;
  down: (pgm: MigrationBuilder) => void;
};

export {};

describe('remove NFT identity migration', () => {
  const pgm = {
    dropConstraint: jest.fn(),
    dropColumns: jest.fn(),
    addColumns: jest.fn(),
    addConstraint: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('drops the uniqueness constraint before the identity columns', () => {
    migration.up(pgm as MigrationBuilder);

    expect(pgm.dropConstraint).toHaveBeenCalledWith('ownable_records', 'ownable_records_nft_unique');
    expect(pgm.dropColumns).toHaveBeenCalledWith('ownable_records', [
      'nft_network',
      'nft_contract_address',
      'nft_token_id',
    ]);
    expect(pgm.dropConstraint.mock.invocationCallOrder[0]).toBeLessThan(pgm.dropColumns.mock.invocationCallOrder[0]);
  });

  it('restores only nullable schema on down', () => {
    migration.down(pgm as MigrationBuilder);

    expect(pgm.addColumns).toHaveBeenCalledWith('ownable_records', {
      nft_network: { type: 'text' },
      nft_contract_address: { type: 'text' },
      nft_token_id: { type: 'text' },
    });
    expect(pgm.addConstraint).toHaveBeenCalledWith('ownable_records', 'ownable_records_nft_unique', {
      unique: ['nft_network', 'nft_contract_address', 'nft_token_id'],
      where: 'nft_network IS NOT NULL AND nft_contract_address IS NOT NULL AND nft_token_id IS NOT NULL',
    });
  });
});
