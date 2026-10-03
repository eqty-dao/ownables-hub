import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { OwnableTransportService } from './ownable-transport.service';

@Module({
  imports: [PersistenceModule],
  providers: [OwnableTransportService],
  exports: [OwnableTransportService],
})
export class OwnableTransportModule {}
