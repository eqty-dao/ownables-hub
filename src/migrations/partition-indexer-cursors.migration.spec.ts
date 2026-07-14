const cursorMigration = require('../../migrations/1717197000000_partition_indexer_cursors.cjs') as {
  up: (pgm: Record<string, jest.Mock>) => void;
  down: (pgm: Record<string, jest.Mock>) => void;
};

describe('partition indexer cursors migration', () => {
  function createPgm() {
    return {
      addConstraint: jest.fn(),
      dropConstraint: jest.fn(),
      sql: jest.fn(),
    };
  }

  it('canonicalizes addresses and replaces slot/name uniqueness with full cursor identity', () => {
    const pgm = createPgm();

    cursorMigration.up(pgm);

    expect(pgm.sql).toHaveBeenCalledWith(
      'UPDATE indexer_cursors SET anchor_contract_address = LOWER(anchor_contract_address)',
    );
    expect(pgm.dropConstraint).toHaveBeenCalledWith('indexer_cursors', 'indexer_cursors_slot_cursor_unique');
    expect(pgm.addConstraint).toHaveBeenCalledWith('indexer_cursors', 'indexer_cursors_identity_unique', {
      unique: ['slot_name', 'cursor_name', 'chain_id', 'anchor_contract_address'],
    });
  });

  it('collapses partitions deterministically before restoring the old constraint on down', () => {
    const pgm = createPgm();

    cursorMigration.down(pgm);

    expect(pgm.sql).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM indexer_cursors older'));
    expect(pgm.dropConstraint).toHaveBeenCalledWith('indexer_cursors', 'indexer_cursors_identity_unique');
    expect(pgm.addConstraint).toHaveBeenCalledWith('indexer_cursors', 'indexer_cursors_slot_cursor_unique', {
      unique: ['slot_name', 'cursor_name'],
    });
  });
});
