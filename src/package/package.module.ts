import { Module } from '@nestjs/common';
import { PackageService } from './package.service';
import { ConfigModule } from '../common/config/config.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [ConfigModule, StorageModule],
  providers: [PackageService],
  exports: [PackageService],
})
export class PackageModule {}
