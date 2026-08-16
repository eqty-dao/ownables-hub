import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module.js';
import { PostgresService } from './postgres.service.js';
import { HubStateRepository } from './repos/hub-state.repository.js';
import { ConfigService } from '../common/config/config.service.js';
import { Pool } from 'pg';
import { POSTGRES_POOL } from './persistence.tokens.js';

const postgresPoolProvider = {
  provide: POSTGRES_POOL,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const databaseUrl = config.getAppConfig().databaseUrl;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    return new Pool({ connectionString: databaseUrl });
  },
};

@Module({
  imports: [ConfigModule],
  providers: [postgresPoolProvider, PostgresService, HubStateRepository],
  exports: [PostgresService, HubStateRepository],
})
export class PersistenceModule {}
