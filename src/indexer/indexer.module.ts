import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { IndexerService } from './indexer.service.js';

@Module({
  imports: [ConfigModule, PersistenceModule],
  providers: [IndexerService],
  exports: [IndexerService],
})
export class IndexerModule {}
