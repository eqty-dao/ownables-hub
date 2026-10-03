import { Module } from '@nestjs/common';
import { NFTService } from './nft.service';
import { EthereumService } from './ethereum/ethereum.service';
import { EthersModule } from '../common/ethers/ethers.module';

@Module({
  imports: [EthersModule],
  providers: [NFTService, EthereumService],
  exports: [NFTService],
})
export class NFTModule {}
