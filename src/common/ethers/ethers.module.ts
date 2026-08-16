import { Module } from '@nestjs/common';
import { ethers } from 'ethers';
import { EthersService } from './ethers.service.js';
import { ConfigModule } from '../config/config.module.js';
import { ETHERS_RPC_PROVIDER_FACTORY } from './ethers.tokens.js';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: ETHERS_RPC_PROVIDER_FACTORY,
      useValue: (rpcUrl: string, network: { name: string; chainId: number }) => new ethers.JsonRpcProvider(rpcUrl, network),
    },
    EthersService,
  ],
  exports: [EthersService],
})
export class EthersModule {}
