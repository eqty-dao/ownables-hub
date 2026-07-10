import { Module } from '@nestjs/common';
import { OwnableController } from './ownable.controller.js';
import { CosmWasmModule } from '../cosmwasm/cosmwasm.module.js';
import { PackageModule } from '../package/package.module.js';
import { ConfigModule } from '../common/config/config.module.js';
import { EthersModule } from '../common/ethers/ethers.module.js';
import { NFTModule } from '../nft/nft.module.js';
import { OwnableService } from './ownable.service.js';
import { HttpModule } from '@nestjs/axios';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { OwnableTransportModule } from './ownable-transport.module.js';

@Module({
  imports: [
    ConfigModule,
    CosmWasmModule,
    PackageModule,
    EthersModule,
    NFTModule,
    HttpModule,
    PersistenceModule,
    StorageModule,
    OwnableTransportModule,
  ],
  providers: [OwnableService],
  controllers: [OwnableController],
})
export class OwnableModule {}
