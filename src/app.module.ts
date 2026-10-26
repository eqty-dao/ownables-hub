import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './common/config/config.module';
import { PackageModule } from './package/package.module';
import { OwnableModule } from './ownable/ownable.module';
import { OwnableController } from './ownable/ownable.controller';
import { SIWEAuthMiddleware } from './common/siwe/siwe-auth.middleware';
import { SIWEModule } from './common/siwe/siwe.module';
import { PersistenceModule } from './persistence/persistence.module';
import { StorageModule } from './storage/storage.module';
import { AccountModule } from './account/account.module';
import { AccountController } from './account/account.controller';
import { PublicEventModule } from './public-event/public-event.module';
import { PublicEventController } from './public-event/public-event.controller';
import { HubModule } from './hub/hub.module';
import { HubController } from './hub/hub.controller';

@Module({
  imports: [
    ConfigModule,
    PackageModule,
    OwnableModule,
    AccountModule,
    PublicEventModule,
    HubModule,
    SIWEModule,
    PersistenceModule,
    StorageModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SIWEAuthMiddleware).forRoutes(OwnableController, AccountController, PublicEventController, HubController);
  }
}
