import { Module } from '@nestjs/common';
import { CosmWasmService } from './cosmwasm.service';

@Module({
  providers: [CosmWasmService],
  exports: [CosmWasmService],
})
export class CosmWasmModule {}
