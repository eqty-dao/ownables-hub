import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, type Notification, type PoolClient, type QueryResult } from 'pg';
import { POSTGRES_POOL } from './persistence.tokens.js';

@Injectable()
export class PostgresService implements OnModuleDestroy {
  private static readonly logger = new Logger(PostgresService.name);
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {
    this.pool.on('error', (error) => {
      PostgresService.logger.error(
        'Postgres pool reported an idle client error; keeping Hub alive and waiting for DB recovery',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }

  async query<T = unknown>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values);
  }

  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async notify(channel: string, payload: string): Promise<void> {
    await this.pool.query('SELECT pg_notify($1, $2)', [channel, payload]);
  }

  async listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    const onNotification = (message: Notification) => {
      if (message.channel !== channel || typeof message.payload !== 'string') {
        return;
      }
      onPayload(message.payload);
    };

    client.on('notification', onNotification);

    try {
      await client.query(`LISTEN ${channel}`);
    } catch (error) {
      client.off('notification', onNotification);
      client.release();
      throw error;
    }

    return async () => {
      client.off('notification', onNotification);
      try {
        await client.query(`UNLISTEN ${channel}`);
      } finally {
        client.release();
      }
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
