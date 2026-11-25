import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { OwnableModule } from '../ownable/ownable.module';
import { PublicEventController } from './public-event.controller';

@Module({
  imports: [ConfigModule, OwnableModule],
  controllers: [PublicEventController],
})
export class PublicEventModule {}
