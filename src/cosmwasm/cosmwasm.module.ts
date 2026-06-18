import { Module } from '@nestjs/common';
import { CosmWasmService } from './cosmwasm.service.js';

@Module({
  providers: [CosmWasmService],
  exports: [CosmWasmService],
})
export class CosmWasmModule {}
