import { Module } from '@nestjs/common';
import { AnchorValidationService, PublicEventReplayService } from '@ownables/core';
import { OwnableController } from './ownable.controller';
import { CosmWasmModule } from '../cosmwasm/cosmwasm.module';
import { PackageModule } from '../package/package.module';
import { ConfigModule } from '../common/config/config.module';
import { EthersModule } from '../common/ethers/ethers.module';
import { NFTModule } from '../nft/nft.module';
import { OwnableService } from './ownable.service';
import { HttpModule } from '@nestjs/axios';
import { PersistenceModule } from '../persistence/persistence.module';
import { StorageModule } from '../storage/storage.module';
import { OwnableTransportModule } from './ownable-transport.module';
import { OwnableReplayService } from './ownable-replay.service';

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
  providers: [
    { provide: AnchorValidationService, useClass: AnchorValidationService },
    { provide: PublicEventReplayService, useClass: PublicEventReplayService },
    OwnableReplayService,
    OwnableService,
  ],
  controllers: [OwnableController],
})
export class OwnableModule {}
