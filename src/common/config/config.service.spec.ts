import { ConfigService } from './config.service.js';

describe('ConfigService', () => {
  it('should expose the active environment', () => {
    process.env.NODE_ENV = 'test';
    const service = new ConfigService();
    expect(service.get('env')).toBe('test');
  });
});
