import { Module } from '@nestjs/common';
import { OwnableModule } from '../ownable/ownable.module';
import { PublicEventController } from './public-event.controller';

@Module({
  imports: [OwnableModule],
  controllers: [PublicEventController],
})
export class PublicEventModule {}
