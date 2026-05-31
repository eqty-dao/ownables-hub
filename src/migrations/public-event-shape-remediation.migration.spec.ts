const migration = require('../../migrations/1717192000000_public_event_shape_remediation.cjs') as {
  up: (pgm: {
    addColumn: (...args: unknown[]) => void;
    createIndex: (...args: unknown[]) => void;
    dropTable: (...args: unknown[]) => void;
    createTable: (...args: unknown[]) => void;
    addConstraint: (...args: unknown[]) => void;
    sql: (...args: unknown[]) => void;
    func: (value: string) => string;
  }) => void;
};

describe('public_event_shape_remediation migration', () => {
  it('resets anchor-public-events cursor during table recreation', () => {
    const pgm = {
      addColumn: jest.fn(),
      createIndex: jest.fn(),
      dropTable: jest.fn(),
      createTable: jest.fn(),
      addConstraint: jest.fn(),
      sql: jest.fn(),
      func: jest.fn((value: string) => value),
    };

    migration.up(pgm);

    expect(pgm.sql).toHaveBeenCalledWith(
      "DELETE FROM indexer_cursors WHERE cursor_name = 'anchor-public-events'",
    );
  });
});
