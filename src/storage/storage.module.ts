import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { storageProviders } from './storage.providers';
import { ArchiveStorageService } from './archive-storage.service';

@Module({
  imports: [ConfigModule],
  providers: [...storageProviders, ArchiveStorageService],
  exports: [...storageProviders, ArchiveStorageService],
})
export class StorageModule {}
