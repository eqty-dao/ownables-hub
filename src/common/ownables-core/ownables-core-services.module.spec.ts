import { Test } from '@nestjs/testing';
import { AnchorValidationService, PublicEventReplayService } from '@ownables/core';
import { OwnablesCoreServicesModule } from './ownables-core-services.module.js';

describe('OwnablesCoreServicesModule', () => {
  it('owns and exports only the surviving core services', async () => {
    const module = await Test.createTestingModule({ imports: [OwnablesCoreServicesModule] }).compile();

    expect(module.get(AnchorValidationService)).toBeInstanceOf(AnchorValidationService);
    expect(module.get(PublicEventReplayService)).toBeInstanceOf(PublicEventReplayService);

    const exports = Reflect.getMetadata('exports', OwnablesCoreServicesModule);
    expect(exports).toHaveLength(2);
    expect(exports.map(({ provide }: { provide: unknown }) => provide)).toEqual([
      AnchorValidationService,
      PublicEventReplayService,
    ]);
  });
});
