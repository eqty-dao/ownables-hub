import { Module } from '@nestjs/common';
import { AnchorValidationService, OwnablePackageCidService, PublicEventReplayService } from '@ownables/core';

const services = [
  { provide: AnchorValidationService, useValue: new AnchorValidationService() },
  { provide: OwnablePackageCidService, useValue: new OwnablePackageCidService() },
  { provide: PublicEventReplayService, useValue: new PublicEventReplayService() },
];

@Module({ providers: services, exports: services })
export class OwnablesCoreServicesModule {}
