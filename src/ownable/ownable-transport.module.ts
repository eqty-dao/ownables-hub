import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { OwnableTransportService } from './ownable-transport.service.js';

@Module({
  imports: [PersistenceModule],
  providers: [OwnableTransportService],
  exports: [OwnableTransportService],
})
export class OwnableTransportModule {}
