import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { EthersModule } from '../common/ethers/ethers.module';
import { HubController } from './hub.controller';

@Module({
  imports: [ConfigModule, EthersModule],
  controllers: [HubController],
})
export class HubModule {}
