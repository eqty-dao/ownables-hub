import { Module } from '@nestjs/common';
import { OwnableController } from './ownable.controller';
import { CosmWasmModule } from '../cosmwasm/cosmwasm.module';
import { PackageModule } from '../package/package.module';
import { ConfigModule } from '../common/config/config.module';
import { EthersModule } from '../common/ethers/ethers.module';
import { NFTModule } from '../nft/nft.module';
import { OwnableService } from './ownable.service';
import { HttpModule } from '@nestjs/axios';
import { IpfsModule } from '../common/ipfs/ipfs.module';

@Module({
  imports: [ConfigModule, IpfsModule, CosmWasmModule, PackageModule, EthersModule, NFTModule, HttpModule],
  providers: [OwnableService],
  controllers: [OwnableController],
})
export class OwnableModule {}
