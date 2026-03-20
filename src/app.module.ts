import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './common/config/config.module';
import { PackageModule } from './package/package.module';
import { OwnableModule } from './ownable/ownable.module';
import { OwnableController } from './ownable/ownable.controller';
import { SIWEAuthMiddleware } from './common/siwe/siwe-auth.middleware';
import { SIWEModule } from './common/siwe/siwe.module';

@Module({
  imports: [ConfigModule, PackageModule, OwnableModule, SIWEModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SIWEAuthMiddleware).forRoutes(OwnableController);
  }
}
