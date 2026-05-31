import { Injectable } from '@nestjs/common';
import path from 'path';

export type AppEnv = 'development' | 'test' | 'staging' | 'production';

export interface AppConfig {
  env: AppEnv;
  port: number;
  logLevel: string;
  publicBaseUrl: string;
  databaseUrl: string;
  ownablesStorage: string;
  siweDomain: string;
}

type ConfigPath =
  | 'env'
  | 'port'
  | 'log.level'
  | 'publicBaseUrl'
  | 'databaseUrl'
  | 'ownablesStorage'
  | 'siwe.domain';

interface RuntimeInternals {
  ethMode: 'testnet' | 'mainnet';
  accountMnemonic: string;
  alchemyApiKeys: {
    arbitrum: string;
    polygon: string;
    ethereum: string;
    base: string;
  };
  baseNftContracts: {
    mainnet: string;
    testnet: string;
  };
  storagePaths: {
    root: string;
    packages: string;
    chains: string;
    users: string;
    nfts: string;
  };
}

function readEnv(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function parseEnv(name: string): AppEnv {
  const raw = readEnv(name, 'development');
  if (raw === 'development' || raw === 'test' || raw === 'staging' || raw === 'production') {
    return raw;
  }
  throw new Error(`Invalid ${name}: ${raw}`);
}

function parseMode(name: string): 'testnet' | 'mainnet' {
  const raw = readEnv(name, 'testnet');
  if (raw === 'testnet' || raw === 'mainnet') {
    return raw;
  }
  throw new Error(`Invalid ${name}: ${raw}`);
}

function parsePort(name: string): number {
  const value = Number(readEnv(name, '3000'));
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value;
}

function resolveStorageRoot(ownablesStorage: string): string {
  const value = ownablesStorage.trim();
  if (!value) {
    return path.resolve(process.cwd(), 'storage');
  }

  if (value.startsWith('file://')) {
    const raw = value.slice('file://'.length);
    return path.resolve(raw);
  }

  if (value.includes('://')) {
    // Non-file bucket DSNs are handled by later workstreams; current flow still needs a local workspace root.
    return path.resolve(process.cwd(), 'storage');
  }

  return path.resolve(value);
}

function buildConfig(): AppConfig {
  const env = parseEnv('NODE_ENV');
  const ownablesStorage = readEnv('OWNABLES_STORAGE', 'file://storage');

  return {
    env,
    port: parsePort('PORT'),
    logLevel: readEnv('LOG_LEVEL', ''),
    publicBaseUrl: readEnv('PUBLIC_BASE_URL', ''),
    databaseUrl: readEnv('DATABASE_URL', ''),
    ownablesStorage,
    siweDomain: readEnv('SIWE_DOMAIN', 'localhost'),
  };
}

@Injectable()
export class ConfigService {
  private readonly config: AppConfig = buildConfig();
  private readonly internals: RuntimeInternals = this.buildInternals();

  get<T = unknown>(key: ConfigPath): T {
    const map: Record<ConfigPath, unknown> = {
      env: this.config.env,
      port: this.config.port,
      'log.level': this.config.logLevel,
      publicBaseUrl: this.config.publicBaseUrl,
      databaseUrl: this.config.databaseUrl,
      ownablesStorage: this.config.ownablesStorage,
      'siwe.domain': this.config.siweDomain,
    };

    return map[key] as T;
  }

  has(key: ConfigPath): boolean {
    return this.get(key) !== undefined;
  }

  getAppConfig(): AppConfig {
    return this.config;
  }

  getStoragePaths(): RuntimeInternals['storagePaths'] {
    return this.internals.storagePaths;
  }

  getEthMode(): RuntimeInternals['ethMode'] {
    return this.internals.ethMode;
  }

  getAccountMnemonic(): string {
    return this.internals.accountMnemonic;
  }

  getAlchemyApiKey(network: keyof RuntimeInternals['alchemyApiKeys']): string {
    return this.internals.alchemyApiKeys[network];
  }

  getBaseNftContractAddress(): string {
    return this.internals.ethMode === 'testnet'
      ? this.internals.baseNftContracts.testnet
      : this.internals.baseNftContracts.mainnet;
  }

  private buildInternals(): RuntimeInternals {
    const rootPath = resolveStorageRoot(this.config.ownablesStorage);

    return {
      ethMode: parseMode('ETH_MODE'),
      accountMnemonic: readEnv('ACCOUNT_MNEMONIC', ''),
      alchemyApiKeys: {
        arbitrum: readEnv('ARBITRUM_ALCHEMY_API_KEY', ''),
        polygon: readEnv('POLYGON_ALCHEMY_API_KEY', ''),
        ethereum: readEnv('ETH_ALCHEMY_API_KEY', ''),
        base: readEnv('BASE_ALCHEMY_API_KEY', ''),
      },
      baseNftContracts: {
        mainnet: readEnv('BASE_NFT_CONTRACT_ADDR', ''),
        testnet: readEnv('BASE_SEPOLIA_NFT_CONTRACT_ADDR', ''),
      },
      storagePaths: {
        root: rootPath,
        packages: path.join(rootPath, 'packages'),
        chains: path.join(rootPath, 'chains'),
        users: path.join(rootPath, 'users'),
        nfts: path.join(rootPath, 'nfts'),
      },
    };
  }
}
