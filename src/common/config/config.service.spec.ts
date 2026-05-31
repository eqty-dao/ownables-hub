import { ConfigService } from './config.service.js';

describe('ConfigService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/hub';
    process.env.TESTNET_CHAIN_ID = '84532';
    process.env.TESTNET_RPC_URL = 'https://testnet-rpc';
    process.env.TESTNET_ANCHOR_CONTRACT_ADDR = '0x1111111111111111111111111111111111111111';
    process.env.TESTNET_ANCHOR_START_BLOCK = '100';
    process.env.MAINNET_CHAIN_ID = '8453';
    process.env.MAINNET_RPC_URL = 'https://mainnet-rpc';
    process.env.MAINNET_ANCHOR_CONTRACT_ADDR = '0x2222222222222222222222222222222222222222';
    process.env.MAINNET_ANCHOR_START_BLOCK = '200';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should expose the active environment', () => {
    process.env.NODE_ENV = 'test';
    const service = new ConfigService();
    expect(service.getAppConfig().env).toBe('test');
  });

  it('throws when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    expect(() => new ConfigService()).toThrow('DATABASE_URL is required');
  });

  it('parses exactly two explicit indexer slots in deterministic order', () => {
    const service = new ConfigService();

    const [testnet, mainnet] = service.getIndexerSlots();
    expect(testnet.slotName).toBe('testnet');
    expect(mainnet.slotName).toBe('mainnet');
    expect(testnet.chainId).toBe('84532');
    expect(mainnet.chainId).toBe('8453');
    expect(testnet.anchorStartBlock).toBe(100n);
    expect(mainnet.anchorStartBlock).toBe(200n);
  });

  it('fails fast when required indexer envs are missing or invalid', () => {
    delete process.env.MAINNET_RPC_URL;
    const service = new ConfigService();
    expect(() => service.getIndexerSlots()).toThrow('MAINNET_RPC_URL is required');

    process.env.MAINNET_RPC_URL = 'https://mainnet-rpc';
    process.env.TESTNET_ANCHOR_START_BLOCK = 'not-a-number';
    const secondService = new ConfigService();
    expect(() => secondService.getIndexerSlots()).toThrow('Invalid TESTNET_ANCHOR_START_BLOCK: not-a-number');
  });
});
