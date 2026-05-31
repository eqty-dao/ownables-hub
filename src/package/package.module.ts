import { Module } from '@nestjs/common';
import { PackageService } from './package.service.js';
import { PackageController } from './package.controller.js';
import { ConfigModule } from '../common/config/config.module.js';
import { JszipModule } from '../common/jszip/jszip.module.js';

@Module({
  imports: [ConfigModule, JszipModule],
  providers: [PackageService],
  controllers: [PackageController],
  exports: [PackageService],
})
export class PackageModule {}
