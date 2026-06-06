const reownNotifyStateMigration = require('../../migrations/1717193000000_reown_notify_state.cjs') as {
  up: (pgm: any) => void;
  down: (pgm: any) => void;
};

describe('reown_notify_state migration', () => {
  it('drops registration tables and recreates account-targeted delivery state', () => {
    const pgm = {
      dropTable: jest.fn(),
      createTable: jest.fn(),
      addConstraint: jest.fn(),
      createIndex: jest.fn(),
      addColumn: jest.fn(),
      sql: jest.fn(),
      func: jest.fn((value: string) => value),
    };

    reownNotifyStateMigration.up(pgm);

    expect(pgm.dropTable).toHaveBeenNthCalledWith(1, 'notify_delivery_state');
    expect(pgm.dropTable).toHaveBeenNthCalledWith(2, 'notify_registrations');
    expect(pgm.createTable).toHaveBeenCalledWith(
      'notify_delivery_state',
      expect.objectContaining({
        owner_account: expect.objectContaining({ notNull: true }),
        notification_id: expect.any(Object),
        transport_id: expect.any(Object),
        error_code: expect.any(Object),
      }),
    );
    expect(pgm.addConstraint).toHaveBeenCalledWith('notify_delivery_state', 'notify_delivery_state_account_dedupe_unique', {
      unique: ['ownable_id', 'owner_account', 'owner_state_version', 'trigger_kind'],
    });
    expect(pgm.createIndex).toHaveBeenCalledWith('notify_delivery_state', ['owner_account', 'status']);
    expect(pgm.createIndex).toHaveBeenCalledWith('notify_delivery_state', ['ownable_id', 'owner_account']);
  });
});
