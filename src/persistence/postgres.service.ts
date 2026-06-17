import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service.js';
import { Pool, type PoolClient, type QueryResult } from 'pg';

@Injectable()
export class PostgresService implements OnModuleDestroy {
  private static readonly logger = new Logger(PostgresService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    const databaseUrl = config.getAppConfig().databaseUrl;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required');
    }
    this.pool = new Pool({
      connectionString: databaseUrl,
    });
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

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
