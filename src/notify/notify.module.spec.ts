import { Test } from '@nestjs/testing';
import { HubStateRepository } from '../persistence/repos/hub-state.repository.js';
import { NotifyModule } from './notify.module.js';
import { NotifyService } from './notify.service.js';

describe('NotifyModule', () => {
  it('compiles with runtime DI providers', async () => {
    process.env.DATABASE_URL ??= 'postgres://planner:planner@127.0.0.1:5432/ownables_hub_test';
    const moduleRef = await Test.createTestingModule({
      imports: [NotifyModule],
    })
      .overrideProvider(HubStateRepository)
      .useValue({})
      .compile();

    expect(moduleRef.get(NotifyService)).toBeInstanceOf(NotifyService);
    await moduleRef.close();
  });
});
