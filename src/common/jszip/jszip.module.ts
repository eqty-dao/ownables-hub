import { Module } from '@nestjs/common';
import { jszipProviders } from './jszip.providers.js';

@Module({
  providers: [...jszipProviders],
  exports: [...jszipProviders],
})
export class JszipModule {}
