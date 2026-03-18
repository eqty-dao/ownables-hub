import { Test, TestingModule } from '@nestjs/testing';
import { SIWEService } from './siwe.service';
import { ConfigService } from '../config/config.service';

describe('SIWEService', () => {
  let service: SIWEService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SIWEService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'siwe.domain') return 'localhost';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SIWEService>(SIWEService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should generate a nonce', () => {
    const nonce = service.generateNonce();
    expect(nonce).toBeDefined();
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBe(32);
  });
});
