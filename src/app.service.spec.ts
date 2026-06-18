import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service.js';
import { PostgresService } from './persistence/postgres.service.js';
import { ArchiveStorageService } from './storage/archive-storage.service.js';

describe('AppService', () => {
  let service: AppService;
  const db = {
    query: jest.fn(),
  };
  const storage = {
    probe: jest.fn(),
  };

  beforeEach(async () => {
    db.query.mockReset();
    storage.probe.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppService,
        { provide: PostgresService, useValue: db },
        { provide: ArchiveStorageService, useValue: storage },
      ],
    }).compile();

    service = module.get<AppService>(AppService);
    service.onModuleInit();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('reports healthy only when database and storage probes succeed', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    storage.probe.mockResolvedValueOnce(undefined);

    await expect(service.getHealth()).resolves.toEqual({
      status: 'ok',
      checks: {
        database: 'ok',
        storage: 'ok',
      },
    });
  });

  it('reports degraded status when a dependency probe fails', async () => {
    db.query.mockRejectedValueOnce(new Error('connection reset'));
    storage.probe.mockResolvedValueOnce(undefined);

    await expect(service.getHealth()).resolves.toEqual({
      status: 'error',
      checks: {
        database: 'error',
        storage: 'ok',
      },
      errors: {
        database: 'connection reset',
      },
    });
  });
});
