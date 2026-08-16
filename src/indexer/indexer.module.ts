import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { IndexerService } from './indexer.service.js';
import { OwnableTransportModule } from '../ownable/ownable-transport.module.js';
import { JsonRpcProvider } from 'ethers';
import { EVM_RPC_PROVIDER_FACTORY } from './indexer.tokens.js';

@Module({
  imports: [ConfigModule, PersistenceModule, OwnableTransportModule],
  providers: [
    { provide: EVM_RPC_PROVIDER_FACTORY, useValue: (slot: { rpcUrl: string }) => new JsonRpcProvider(slot.rpcUrl) },
    IndexerService,
  ],
  exports: [IndexerService],
})
export class IndexerModule {}
