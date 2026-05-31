import { Test, TestingModule } from '@nestjs/testing';
import { SIWEService } from './siwe.service.js';
import { ConfigService } from '../config/config.service.js';

describe('SIWEService', () => {
  let service: SIWEService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SIWEService,
        {
          provide: ConfigService,
          useValue: {
            getAppConfig: jest.fn(() => ({
              siweDomain: 'localhost',
            })),
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
