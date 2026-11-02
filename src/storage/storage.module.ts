import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { storageProviders } from './storage.providers';
import { ArchiveStorageService } from './archive-storage.service';
import { QuarantineStorageService } from './quarantine-storage.service';

@Module({
  imports: [ConfigModule],
  providers: [...storageProviders, ArchiveStorageService, QuarantineStorageService],
  exports: [...storageProviders, ArchiveStorageService, QuarantineStorageService],
})
export class StorageModule {}
