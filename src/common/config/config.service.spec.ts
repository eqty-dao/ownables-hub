import { ConfigService } from './config.service';

describe('ConfigService', () => {
  const originalEnv = process.env;
  const setQuarantineEnv = () => {
    Object.assign(process.env, {
      QUARANTINE_STORAGE: 'file://tmp/quarantine',
      UPLOAD_INGRESS_CONCURRENCY: '1',
      UPLOAD_RATE_LIMIT_WINDOW_SECONDS: '60',
      UPLOAD_RATE_LIMIT_MAX_REQUESTS: '8',
      UPLOAD_PROCESSING_CONCURRENCY: '1',
      UPLOAD_MAX_EXPANDED_PROCESSING_BYTES: '536870912',
      QUARANTINE_MAX_PENDING_OBJECTS: '4',
      QUARANTINE_MAX_PENDING_BYTES: '536870912',
      QUARANTINE_RETENTION_SECONDS: '86400',
      QUARANTINE_PROMOTION_BATCH_SIZE: '16',
      QUARANTINE_CLEANUP_BATCH_SIZE: '16',
      QUARANTINE_LEASE_SECONDS: '300',
      QUARANTINE_ORPHAN_GRACE_SECONDS: '60',
    });
  };

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
    setQuarantineEnv();
    process.env.CORS_ORIGINS = 'https://sdk.example.com, http://127.0.0.1:5173 ,https://sdk.example.com';

    const service = new ConfigService();

    expect(service.getAppConfig().corsOrigins).toEqual(['https://sdk.example.com', 'http://127.0.0.1:5173']);
  });

  it('throws when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    expect(() => new ConfigService()).toThrow('DATABASE_URL is required');
  });

  it('requires quarantine storage and budgets in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.QUARANTINE_STORAGE;

    expect(() => new ConfigService()).toThrow('QUARANTINE_STORAGE is required');

    process.env.QUARANTINE_STORAGE = 's3://hub-private/quarantine';
    expect(() => new ConfigService()).toThrow('UPLOAD_INGRESS_CONCURRENCY is required and must be a positive integer');
  });

  it('uses configured indexer networks and ignores the legacy profile selector', () => {
    process.env.INDEXER_NETWORKS = 'base-sepolia';
    process.env.HUB_NETWORK_PROFILE = 'mainnet';
    delete process.env.MAINNET_CHAIN_ID;
    delete process.env.MAINNET_RPC_URL;
    delete process.env.MAINNET_ANCHOR_CONTRACT_ADDR;
    delete process.env.MAINNET_ANCHOR_START_BLOCK;

    expect(new ConfigService().getEnabledIndexerSlots()).toEqual([
      expect.objectContaining({
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x1111111111111111111111111111111111111111',
        anchorStartBlock: 100n,
      }),
    ]);
  });

  it('requires a complete deployed Anchor configuration for every enabled indexer network', () => {
    process.env.INDEXER_NETWORKS = 'base';
    delete process.env.MAINNET_ANCHOR_CONTRACT_ADDR;
    delete process.env.MAINNET_ANCHOR_START_BLOCK;

    expect(() => new ConfigService().getEnabledIndexerSlots()).toThrow(
      'Indexer network base requires an Anchor address and start block',
    );
  });

  it('rejects duplicate and unsupported enabled indexer networks', () => {
    process.env.INDEXER_NETWORKS = 'base-sepolia,base-sepolia';
    expect(() => new ConfigService().getEnabledIndexerSlots()).toThrow('INDEXER_NETWORKS must not contain duplicate networks');

    process.env.INDEXER_NETWORKS = 'arbitrum';
    expect(() => new ConfigService().getEnabledIndexerSlots()).toThrow('Unsupported Hub network: arbitrum');
  });

  it('resolves both Base request networks while allowing an undeployed Mainnet Anchor', () => {
    delete process.env.MAINNET_CHAIN_ID;
    delete process.env.MAINNET_RPC_URL;
    delete process.env.MAINNET_ANCHOR_CONTRACT_ADDR;
    delete process.env.MAINNET_ANCHOR_START_BLOCK;

    const service = new ConfigService();

    expect(service.resolveHubNetwork('base')).toEqual({
      slug: 'base',
      caip2: 'eip155:8453',
      chainId: '8453',
      slotName: 'mainnet',
      rpcUrl: 'https://mainnet.base.org',
      anchorContractAddress: undefined,
      anchorStartBlock: undefined,
    });
    expect(service.resolveHubNetwork('base-sepolia')).toEqual(
      expect.objectContaining({
        slug: 'base-sepolia',
        caip2: 'eip155:84532',
        chainId: '84532',
        slotName: 'testnet',
      }),
    );
    expect(() => service.resolveHubNetwork('ethereum')).toThrow('Unsupported Hub network: ethereum');
  });

  it('enables recipient discovery only outside production when the env flag is truthy', () => {
    process.env.LOCAL_DEV_RECIPIENT_DISCOVERY_ENABLED = 'true';

    process.env.NODE_ENV = 'test';
    process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8000';
    expect(new ConfigService().isLocalDevRecipientDiscoveryEnabled()).toBe(true);

    process.env.NODE_ENV = 'production';
    setQuarantineEnv();
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
