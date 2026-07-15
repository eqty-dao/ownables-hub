import { Module } from '@nestjs/common';
import { AnchorValidationService, PublicEventReplayService } from '@ownables/core';

const services = [
  { provide: AnchorValidationService, useValue: new AnchorValidationService() },
  { provide: PublicEventReplayService, useValue: new PublicEventReplayService() },
];

@Module({ providers: services, exports: services })
export class OwnablesCoreServicesModule {}
