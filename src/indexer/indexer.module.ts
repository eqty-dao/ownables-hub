import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { IndexerService } from './indexer.service';
import { OwnableTransportModule } from '../ownable/ownable-transport.module';
import { JsonRpcProvider } from 'ethers';
import { EVM_RPC_PROVIDER_FACTORY } from './indexer.tokens';
import { OwnableModule } from '../ownable/ownable.module';

@Module({
  imports: [ConfigModule, PersistenceModule, OwnableTransportModule, OwnableModule],
  providers: [
    { provide: EVM_RPC_PROVIDER_FACTORY, useValue: (slot: { rpcUrl: string }) => new JsonRpcProvider(slot.rpcUrl) },
    IndexerService,
  ],
  exports: [IndexerService],
})
export class IndexerModule {}
