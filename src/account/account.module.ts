import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { OwnableModule } from '../ownable/ownable.module';
import { AccountController } from './account.controller';

@Module({
  imports: [ConfigModule, OwnableModule],
  controllers: [AccountController],
})
export class AccountModule {}
