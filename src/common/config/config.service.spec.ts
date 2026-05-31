import { ConfigService } from './config.service.js';

describe('ConfigService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should expose the active environment', () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/hub';
    const service = new ConfigService();
    expect(service.getAppConfig().env).toBe('test');
  });

  it('throws when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    expect(() => new ConfigService()).toThrow('DATABASE_URL is required');
  });
});
