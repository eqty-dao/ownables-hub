const removeNotifyDeliveryStateMigration = require('../../migrations/1717195000000_remove_notify_delivery_state.cjs') as {
  up: (pgm: any) => void;
  down: (pgm: any) => void;
};

describe('remove_notify_delivery_state migration', () => {
  it('drops notify delivery state on upgrade', () => {
    const pgm = {
      dropTable: jest.fn(),
    };

    removeNotifyDeliveryStateMigration.up(pgm);

    expect(pgm.dropTable).toHaveBeenCalledWith('notify_delivery_state', { ifExists: true });
  });

  it('recreates notify delivery state on downgrade', () => {
    const pgm = {
      createTable: jest.fn(),
      addConstraint: jest.fn(),
      createIndex: jest.fn(),
      func: jest.fn((value: string) => value),
    };

    removeNotifyDeliveryStateMigration.down(pgm);

    expect(pgm.createTable).toHaveBeenCalledWith(
      'notify_delivery_state',
      expect.objectContaining({
        owner_account: expect.objectContaining({ notNull: true }),
        notification_id: expect.any(Object),
      }),
    );
    expect(pgm.addConstraint).toHaveBeenCalledWith('notify_delivery_state', 'notify_delivery_state_account_dedupe_unique', {
      unique: ['ownable_id', 'owner_account', 'owner_state_version', 'trigger_kind'],
    });
    expect(pgm.createIndex).toHaveBeenCalledWith('notify_delivery_state', ['owner_account', 'status']);
    expect(pgm.createIndex).toHaveBeenCalledWith('notify_delivery_state', ['ownable_id', 'owner_account']);
  });
});
