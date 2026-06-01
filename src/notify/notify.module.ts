import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { NotifyController } from './notify.controller.js';
import { LocalNotifyTransport } from './local-notify.transport.js';
import { NOTIFY_PUBLISHER_TRANSPORT, NotifyService } from './notify.service.js';

@Module({
  imports: [PersistenceModule],
  providers: [
    NotifyService,
    {
      provide: NOTIFY_PUBLISHER_TRANSPORT,
      useFactory: () => new LocalNotifyTransport(),
    },
  ],
  controllers: [NotifyController],
  exports: [NotifyService],
})
export class NotifyModule {}
