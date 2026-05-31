import { Module } from '@nestjs/common';
import { NFTService } from './nft.service.js';
import { EthereumService } from './ethereum/ethereum.service.js';
import { EthersModule } from '../common/ethers/ethers.module.js';

@Module({
  imports: [EthersModule],
  providers: [NFTService, EthereumService],
  exports: [NFTService],
})
export class NFTModule {}
