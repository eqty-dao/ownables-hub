import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { EthersModule } from '../common/ethers/ethers.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { AnchorEvidenceController } from './anchor-evidence.controller';
import { HubController } from './hub.controller';

@Module({
  imports: [ConfigModule, EthersModule, PersistenceModule],
  controllers: [HubController, AnchorEvidenceController],
})
export class HubModule {}
