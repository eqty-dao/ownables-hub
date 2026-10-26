import { Module } from '@nestjs/common';
import { EthersModule } from '../common/ethers/ethers.module';
import { HubController } from './hub.controller';

@Module({
  imports: [EthersModule],
  controllers: [HubController],
})
export class HubModule {}
