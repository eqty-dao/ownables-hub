const ownerAccountMigration = require('../../migrations/1717194000000_owner_state_owner_account_recipient_discovery.cjs') as {
  up: (pgm: any) => void;
  down: (pgm: any) => void;
};

describe('owner_state_owner_account_recipient_discovery migration', () => {
  it('adds current_owner_account and backfill support for recipient discovery', () => {
    const pgm = {
      addColumn: jest.fn(),
      createIndex: jest.fn(),
      dropIndex: jest.fn(),
      dropColumns: jest.fn(),
      sql: jest.fn(),
    };

    ownerAccountMigration.up(pgm);

    expect(pgm.addColumn).toHaveBeenCalledWith('ownable_owner_state', {
      current_owner_account: { type: 'text' },
    });
    expect(pgm.createIndex).toHaveBeenCalledWith('ownable_owner_state', 'current_owner_account');
    expect(pgm.sql).toHaveBeenCalledWith(expect.stringContaining('UPDATE ownable_owner_state os'));
    expect(pgm.sql).toHaveBeenCalledWith(expect.stringContaining("owner_account NOT LIKE 'unknown:%'"));
  });
});
