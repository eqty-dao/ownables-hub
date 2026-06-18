import { Module } from '@nestjs/common';
import { SIWEService } from './siwe.service.js';
import { SIWEAuthMiddleware } from './siwe-auth.middleware.js';
import { SIWEGuard } from './siwe.guard.js';
import { AuthController } from './auth.controller.js';
import { ConfigModule } from '../config/config.module.js';

@Module({
  imports: [ConfigModule],
  providers: [SIWEService, SIWEAuthMiddleware, SIWEGuard],
  controllers: [AuthController],
  exports: [SIWEService, SIWEAuthMiddleware, SIWEGuard],
})
export class SIWEModule {}
