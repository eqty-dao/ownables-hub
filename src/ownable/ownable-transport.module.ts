import { Module } from '@nestjs/common';
import { OwnableTransportService } from './ownable-transport.service.js';

@Module({
  providers: [OwnableTransportService],
  exports: [OwnableTransportService],
})
export class OwnableTransportModule {}
