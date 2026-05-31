import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module.js';
import { PostgresService } from './postgres.service.js';
import { HubStateRepository } from './repos/hub-state.repository.js';

@Module({
  imports: [ConfigModule],
  providers: [PostgresService, HubStateRepository],
  exports: [PostgresService, HubStateRepository],
})
export class PersistenceModule {}
