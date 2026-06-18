import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service.js';
import { PostgresService } from './postgres.service.js';

const queryMock = jest.fn();
const connectMock = jest.fn();
const endMock = jest.fn();

class MockPool extends EventEmitter {
  query = queryMock;
  connect = connectMock;
  end = endMock;
}

jest.mock('pg', () => ({
  Pool: jest.fn(() => new MockPool()),
}));

describe('PostgresService', () => {
  const config = {
    getAppConfig: () => ({
      databaseUrl: 'postgres://user:pass@127.0.0.1:5432/ownables_hub',
    }),
  } as ConfigService;

  beforeEach(() => {
    queryMock.mockReset();
    connectMock.mockReset();
    endMock.mockReset();
    jest.restoreAllMocks();
  });

  it('logs idle client errors without crashing the process', () => {
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new PostgresService(config);

    expect(() =>
      (service as unknown as { pool: MockPool }).pool.emit('error', new Error('terminating connection due to administrator command')),
    ).not.toThrow();

    expect(loggerSpy).toHaveBeenCalledWith(
      'Postgres pool reported an idle client error; keeping Hub alive and waiting for DB recovery',
      expect.stringContaining('terminating connection due to administrator command'),
    );
  });

  it('continues serving queries after an idle client error once the database is reachable again', async () => {
    const service = new PostgresService(config);
    const pool = (service as unknown as { pool: MockPool }).pool;

    queryMock
      .mockRejectedValueOnce(new Error('terminating connection due to administrator command'))
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    pool.emit('error', new Error('terminating connection due to administrator command'));

    await expect(service.query('SELECT 1')).rejects.toThrow('terminating connection due to administrator command');
    await expect(service.query('SELECT 1')).resolves.toEqual({ rows: [{ '?column?': 1 }] });
  });
});
