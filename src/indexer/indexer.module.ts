import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { IndexerService } from './indexer.service';
import { OwnableTransportModule } from '../ownable/ownable-transport.module';
import { JsonRpcProvider } from 'ethers';
import { EVM_RPC_PROVIDER_FACTORY } from './indexer.tokens';

@Module({
  imports: [ConfigModule, PersistenceModule, OwnableTransportModule],
  providers: [
    { provide: EVM_RPC_PROVIDER_FACTORY, useValue: (slot: { rpcUrl: string }) => new JsonRpcProvider(slot.rpcUrl) },
    IndexerService,
  ],
  exports: [IndexerService],
})
export class IndexerModule {}
