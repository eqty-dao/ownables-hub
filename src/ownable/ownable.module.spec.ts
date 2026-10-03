jest.mock('@ownables/core/utils', () => ({
  calculateOwnablePackageCid: (entries: Array<{ path: string }>) =>
    `cid-${entries.map((entry) => entry.path).sort().join('-')}`,
}));

import { Test } from '@nestjs/testing';
import { AnchorValidationService, PublicEventReplayService } from '@ownables/core';
import { ConfigService } from '../common/config/config.service';
import { POSTGRES_POOL } from '../persistence/persistence.tokens';
import { PostgresService } from '../persistence/postgres.service';
import { ArchiveStorageService } from '../storage/archive-storage.service';
import { OWNABLES_BUCKET } from '../storage/storage.tokens';
import { OwnableModule } from './ownable.module';
import { OwnableReplayService } from './ownable-replay.service';
import { OwnableService } from './ownable.service';

describe('OwnableModule', () => {
  it('owns the real Nest-managed replay dependencies', async () => {
    const module = await Test.createTestingModule({ imports: [OwnableModule] })
      .overrideProvider(ConfigService)
      .useValue({})
      .overrideProvider(POSTGRES_POOL)
      .useValue({ on: jest.fn(), end: jest.fn() })
      .overrideProvider(OWNABLES_BUCKET)
      .useValue({})
      .overrideProvider(ArchiveStorageService)
      .useValue({})
      .overrideProvider(OwnableService)
      .useValue({})
      .compile();

    const anchorValidation = module.get(AnchorValidationService);
    const publicEventReplay = module.get(PublicEventReplayService);
    const replay = module.get(OwnableReplayService);
    const replayDependencies = replay as unknown as {
      anchorValidation: AnchorValidationService;
      publicEventReplay: PublicEventReplayService;
    };

    expect(anchorValidation).toBeInstanceOf(AnchorValidationService);
    expect(publicEventReplay).toBeInstanceOf(PublicEventReplayService);
    expect(replayDependencies.anchorValidation).toBe(anchorValidation);
    expect(replayDependencies.publicEventReplay).toBe(publicEventReplay);
  });
});
