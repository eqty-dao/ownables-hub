import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { NotifyController } from './notify.controller.js';
import { NotifyService } from './notify.service.js';

@Module({
  imports: [PersistenceModule],
  providers: [NotifyService],
  controllers: [NotifyController],
  exports: [NotifyService],
})
export class NotifyModule {}
