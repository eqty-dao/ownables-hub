import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service.js';
import { PostgresService } from './postgres.service.js';
import { Pool } from 'pg';
import { Test, type TestingModule } from '@nestjs/testing';
import { POSTGRES_POOL } from './persistence.tokens.js';
import { OwnableTransportService } from '../ownable/ownable-transport.service.js';

const queryMock = jest.fn();
const connectMock = jest.fn();
const endMock = jest.fn();
const releaseMock = jest.fn();

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
    releaseMock.mockReset();
    jest.restoreAllMocks();
  });

  const createModule = async (): Promise<TestingModule> =>
    Test.createTestingModule({
      providers: [
        PostgresService,
        { provide: POSTGRES_POOL, useValue: new Pool({ connectionString: config.getAppConfig().databaseUrl }) },
      ],
    }).compile();

  it('logs idle client errors without crashing the process', async () => {
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const module = await createModule();
    const service = module.get(PostgresService);

    expect(() =>
      (service as unknown as { pool: MockPool }).pool.emit('error', new Error('terminating connection due to administrator command')),
    ).not.toThrow();

    expect(loggerSpy).toHaveBeenCalledWith(
      'Postgres pool reported an idle client error; keeping Hub alive and waiting for DB recovery',
      expect.stringContaining('terminating connection due to administrator command'),
    );
    await module.close();
  });

  it('continues serving queries after an idle client error once the database is reachable again', async () => {
    const module = await createModule();
    const service = module.get(PostgresService);
    const pool = (service as unknown as { pool: MockPool }).pool;

    queryMock
      .mockRejectedValueOnce(new Error('terminating connection due to administrator command'))
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    pool.emit('error', new Error('terminating connection due to administrator command'));

    await expect(service.query('SELECT 1')).rejects.toThrow('terminating connection due to administrator command');
    await expect(service.query('SELECT 1')).resolves.toEqual({ rows: [{ '?column?': 1 }] });
    await module.close();
  });

  it('bridges LISTEN notifications through a dedicated client and cleans up on unsubscribe', async () => {
    const listenerClient = new EventEmitter() as EventEmitter & {
      query: typeof queryMock;
      release: typeof releaseMock;
    };
    listenerClient.query = jest.fn().mockResolvedValue({ rows: [] });
    listenerClient.release = releaseMock;
    connectMock.mockResolvedValue(listenerClient);

    const module = await createModule();
    const service = module.get(PostgresService);
    const received: string[] = [];
    const stop = await service.listen('ownables_public_events', (payload) => received.push(payload));

    expect(listenerClient.query).toHaveBeenCalledWith('LISTEN ownables_public_events');

    listenerClient.emit('notification', {
      channel: 'ownables_public_events',
      payload: '{"ok":true}',
    });
    listenerClient.emit('notification', {
      channel: 'ignored_channel',
      payload: '{"ignored":true}',
    });

    expect(received).toEqual(['{"ok":true}']);

    await stop();

    expect(listenerClient.query).toHaveBeenCalledWith('UNLISTEN ownables_public_events');
    expect(releaseMock).toHaveBeenCalled();
    await module.close();
  });

  it('publishes NOTIFY payloads through pg_notify', async () => {
    const module = await createModule();
    const service = module.get(PostgresService);

    await service.notify('ownables_public_events', '{"ok":true}');

    expect(queryMock).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', ['ownables_public_events', '{"ok":true}']);
    await module.close();
  });

  it('closes the injected Pool exactly once through Nest shutdown', async () => {
    const module = await createModule();

    await module.close();

    expect(endMock).toHaveBeenCalledTimes(1);
  });

  it('releases the listener and closes the Pool exactly once through Nest shutdown', async () => {
    const listenerClient = new EventEmitter() as EventEmitter & {
      query: jest.Mock;
      release: typeof releaseMock;
    };
    listenerClient.query = jest.fn().mockResolvedValue({ rows: [] });
    listenerClient.release = releaseMock;
    connectMock.mockResolvedValue(listenerClient);
    const module = await Test.createTestingModule({
      providers: [
        PostgresService,
        OwnableTransportService,
        { provide: POSTGRES_POOL, useValue: new Pool({ connectionString: config.getAppConfig().databaseUrl }) },
      ],
    }).compile();

    await module.init();
    await module.close();

    expect(listenerClient.query).toHaveBeenCalledWith('LISTEN ownables_public_events');
    expect(listenerClient.query).toHaveBeenCalledWith('UNLISTEN ownables_public_events');
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(endMock).toHaveBeenCalledTimes(1);
  });
});
