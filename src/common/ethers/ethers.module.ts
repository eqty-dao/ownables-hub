import { Module } from '@nestjs/common';
import { EthersService } from './ethers.service.js';
import { ConfigModule } from '../config/config.module.js';

@Module({
  imports: [ConfigModule],
  providers: [EthersService],
  exports: [EthersService],
})
export class EthersModule {}
