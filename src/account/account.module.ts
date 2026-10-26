import { Module } from '@nestjs/common';
import { OwnableModule } from '../ownable/ownable.module';
import { AccountController } from './account.controller';

@Module({
  imports: [OwnableModule],
  controllers: [AccountController],
})
export class AccountModule {}
