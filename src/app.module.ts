import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from './common/config/config.module.js';
import { PackageModule } from './package/package.module.js';
import { OwnableModule } from './ownable/ownable.module.js';
import { OwnableController } from './ownable/ownable.controller.js';
import { SIWEAuthMiddleware } from './common/siwe/siwe-auth.middleware.js';
import { SIWEModule } from './common/siwe/siwe.module.js';
import { NotifyModule } from './notify/notify.module.js';
import { NotifyController } from './notify/notify.controller.js';

@Module({
  imports: [ConfigModule, PackageModule, OwnableModule, NotifyModule, SIWEModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SIWEAuthMiddleware).forRoutes(OwnableController, NotifyController);
  }
}
