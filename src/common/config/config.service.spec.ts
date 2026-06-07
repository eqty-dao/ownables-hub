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

  it('defaults localhost SDK dev origins outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ORIGINS;

    const service = new ConfigService();

    expect(service.getAppConfig().corsOrigins).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
  });

  it('parses explicit CORS origins from env and disables implicit defaults', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = 'https://sdk.example.com, http://127.0.0.1:5173 ,https://sdk.example.com';

    const service = new ConfigService();

    expect(service.getAppConfig().corsOrigins).toEqual(['https://sdk.example.com', 'http://127.0.0.1:5173']);
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

  it('treats missing Reown notify config as a non-boot issue', () => {
    const service = new ConfigService();

    expect(service.getReownConfig()).toBeNull();
    expect(service.getReownConfigIssue()).toEqual({
      code: 'missing_reown_config',
      message:
        'Reown notify is disabled because REOWN_PROJECT_ID, REOWN_NOTIFY_API_SECRET, REOWN_NOTIFICATION_TYPE_ID, and REOWN_APP_DOMAIN are not configured.',
    });
  });

  it('validates Reown domain alignment when notify config is enabled', () => {
    process.env.PUBLIC_BASE_URL = 'https://hub.example.com';
    process.env.REOWN_PROJECT_ID = 'proj';
    process.env.REOWN_NOTIFY_API_SECRET = 'secret';
    process.env.REOWN_NOTIFICATION_TYPE_ID = 'type-id';
    process.env.REOWN_APP_DOMAIN = 'notify.example.com';

    const service = new ConfigService();
    expect(service.getReownConfig()).toEqual({
      projectId: 'proj',
      notifyApiSecret: 'secret',
      notificationTypeId: 'type-id',
      appDomain: 'notify.example.com',
    });
    expect(service.getReownConfigIssue()).toEqual({
      code: 'domain_mismatch',
      message: 'PUBLIC_BASE_URL host hub.example.com does not match REOWN_APP_DOMAIN notify.example.com.',
    });
  });

  it('enables recipient discovery only outside production when the env flag is truthy', () => {
    process.env.LOCAL_DEV_RECIPIENT_DISCOVERY_ENABLED = 'true';

    process.env.NODE_ENV = 'test';
    process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8000';
    expect(new ConfigService().isLocalDevRecipientDiscoveryEnabled()).toBe(true);

    process.env.NODE_ENV = 'production';
    expect(new ConfigService().isLocalDevRecipientDiscoveryEnabled()).toBe(false);
  });

  it('fails fast when recipient discovery is enabled without PUBLIC_BASE_URL', () => {
    process.env.NODE_ENV = 'test';
    process.env.LOCAL_DEV_RECIPIENT_DISCOVERY_ENABLED = 'true';
    delete process.env.PUBLIC_BASE_URL;

    expect(() => new ConfigService()).toThrow(
      'PUBLIC_BASE_URL is required when LOCAL_DEV_RECIPIENT_DISCOVERY_ENABLED is enabled',
    );
  });
});
