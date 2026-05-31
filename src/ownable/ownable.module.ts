import { Module } from '@nestjs/common';
import { OwnableController } from './ownable.controller.js';
import { CosmWasmModule } from '../cosmwasm/cosmwasm.module.js';
import { PackageModule } from '../package/package.module.js';
import { ConfigModule } from '../common/config/config.module.js';
import { EthersModule } from '../common/ethers/ethers.module.js';
import { NFTModule } from '../nft/nft.module.js';
import { OwnableService } from './ownable.service.js';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [ConfigModule, CosmWasmModule, PackageModule, EthersModule, NFTModule, HttpModule],
  providers: [OwnableService],
  controllers: [OwnableController],
})
export class OwnableModule {}
