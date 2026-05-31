import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service.js';
import { ConfigModule } from './common/config/config.module.js';

describe('AppService', () => {
  let service: AppService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule],
      providers: [AppService],
    }).compile();

    service = module.get<AppService>(AppService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
