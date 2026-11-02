import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { StorageModule } from '../storage/storage.module';
import { QuarantineService } from './quarantine.service';
import { QuarantineUploadInterceptor } from './quarantine-upload.interceptor';
import { MulterFileSizeFilter } from './multer-file-size.filter';

@Module({
  imports: [ConfigModule, PersistenceModule, StorageModule],
  providers: [QuarantineService, QuarantineUploadInterceptor, MulterFileSizeFilter],
  exports: [QuarantineService, QuarantineUploadInterceptor, MulterFileSizeFilter],
})
export class QuarantineModule {}
