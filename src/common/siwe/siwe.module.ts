import { Module } from '@nestjs/common';
import { SIWEService } from './siwe.service';
import { SIWEAuthMiddleware } from './siwe-auth.middleware';
import { SIWEGuard } from './siwe.guard';
import { AuthController } from './auth.controller';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [ConfigModule],
  providers: [SIWEService, SIWEAuthMiddleware, SIWEGuard],
  controllers: [AuthController],
  exports: [SIWEService, SIWEAuthMiddleware, SIWEGuard],
})
export class SIWEModule {}
