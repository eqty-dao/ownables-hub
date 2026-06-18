import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module.js';
import { storageProviders } from './storage.providers.js';
import { ArchiveStorageService } from './archive-storage.service.js';

@Module({
  imports: [ConfigModule],
  providers: [...storageProviders, ArchiveStorageService],
  exports: [...storageProviders, ArchiveStorageService],
})
export class StorageModule {}
