import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { PostgresService } from './postgres.service';
import { HubStateRepository } from './repos/hub-state.repository';
import { ConfigService } from '../common/config/config.service';
import { Pool } from 'pg';
import { POSTGRES_POOL } from './persistence.tokens';

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
