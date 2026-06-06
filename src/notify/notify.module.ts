import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module.js';
import { ConfigService } from '../common/config/config.service.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { NotifyController } from './notify.controller.js';
import { NOTIFY_PUBLISHER_TRANSPORT, NotifyService } from './notify.service.js';
import { ReownNotifyTransport } from './reown-notify.transport.js';

@Module({
  imports: [ConfigModule, PersistenceModule],
  providers: [
    NotifyService,
    {
      provide: NOTIFY_PUBLISHER_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new ReownNotifyTransport(config),
    },
  ],
  controllers: [NotifyController],
  exports: [NotifyService],
})
export class NotifyModule {}
