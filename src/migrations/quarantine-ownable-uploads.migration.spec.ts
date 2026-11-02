type MigrationBuilder = {
  addColumns: (...args: unknown[]) => void;
  createIndex: (...args: unknown[]) => void;
  createTable: (...args: unknown[]) => void;
  addConstraint: (...args: unknown[]) => void;
  dropColumns: (...args: unknown[]) => void;
  dropIndex: (...args: unknown[]) => void;
  dropTable: (...args: unknown[]) => void;
};

const migration = require('../../migrations/1717199000000_quarantine_ownable_uploads.cjs') as {
  up: (pgm: MigrationBuilder) => void;
  down: (pgm: MigrationBuilder) => void;
};

export {};

describe('quarantine Ownable uploads migration', () => {
  const pgm = {
    addColumns: jest.fn(),
    createIndex: jest.fn(),
    createTable: jest.fn(),
    addConstraint: jest.fn(),
    dropColumns: jest.fn(),
    dropIndex: jest.fn(),
    dropTable: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('creates isolated quarantine rows and database-global ingress tables', () => {
    migration.up(pgm as MigrationBuilder);

    expect(pgm.createTable).toHaveBeenCalledWith('quarantined_ownable_uploads', expect.objectContaining({
      upload_digest: expect.objectContaining({ notNull: true }),
      private_object_key: expect.objectContaining({ notNull: true }),
      expires_at: expect.objectContaining({ notNull: true }),
    }));
    expect(pgm.createTable).toHaveBeenCalledWith('quarantine_ingress_leases', expect.any(Object));
    expect(pgm.createTable).toHaveBeenCalledWith('quarantine_processing_leases', expect.any(Object));
    expect(pgm.createTable).toHaveBeenCalledWith('quarantine_request_windows', expect.any(Object));
    expect(pgm.createIndex).toHaveBeenCalledWith('quarantined_ownable_uploads', 'upload_digest', expect.objectContaining({
      unique: true,
      where: "status IN ('pending', 'promoting')",
    }));
  });

  it('removes only Story #10 schema additions on down', () => {
    migration.down(pgm as MigrationBuilder);

    expect(pgm.dropTable).toHaveBeenCalledWith('quarantine_request_windows');
    expect(pgm.dropTable).toHaveBeenCalledWith('quarantine_processing_leases');
    expect(pgm.dropTable).toHaveBeenCalledWith('quarantine_ingress_leases');
    expect(pgm.dropTable).toHaveBeenCalledWith('quarantined_ownable_uploads');
    expect(pgm.dropColumns).toHaveBeenCalledWith('ownable_records', ['upload_digest', 'chain_storage_key', 'ownable_identity']);
  });
