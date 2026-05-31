import { Injectable } from '@nestjs/common';
import path from 'path';

export type AppEnv = 'development' | 'test' | 'staging' | 'production';
export type RuntimeNetworkProfile = 'testnet' | 'mainnet';
export type EvmNetworkName = 'eip155:ethereum' | 'eip155:arbitrum' | 'eip155:polygon' | 'eip155:base';

export interface AppConfig {
  env: AppEnv;
  port: number;
  logLevel: string;
  publicBaseUrl: string;
  databaseUrl: string;
  ownablesStorage: string;
  siweDomain: string;
}

interface ChainRpcUrls {
  ethereum: string;
  arbitrum: string;
  polygon: string;
  base: string;
}

interface RuntimeConfig {
  networkProfile: RuntimeNetworkProfile;
  authoritySignerMnemonic: string;
  rpcUrls: {
    testnet: ChainRpcUrls;
    mainnet: ChainRpcUrls;
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

function parseRuntimeNetworkProfile(name: string): RuntimeNetworkProfile {
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

export function resolveStorageRoot(ownablesStorage: string): string {
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
  const databaseUrl = readEnv('DATABASE_URL', '');
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  return {
    env,
    port: parsePort('PORT'),
    logLevel: readEnv('LOG_LEVEL', ''),
    publicBaseUrl: readEnv('PUBLIC_BASE_URL', ''),
    databaseUrl,
    ownablesStorage,
    siweDomain: readEnv('SIWE_DOMAIN', 'localhost'),
  };
}

@Injectable()
export class ConfigService {
  private readonly config: AppConfig = buildConfig();
  private readonly runtimeConfig: RuntimeConfig = this.buildRuntimeConfig();

  getAppConfig(): AppConfig {
    return this.config;
  }

  getRuntimeNetworkProfile(): RuntimeNetworkProfile {
    return this.runtimeConfig.networkProfile;
  }

  getAuthoritySignerMnemonic(): string {
    return this.runtimeConfig.authoritySignerMnemonic;
  }

  getRpcUrl(profile: RuntimeNetworkProfile, network: EvmNetworkName): string {
    switch (network) {
      case 'eip155:ethereum':
        return this.runtimeConfig.rpcUrls[profile].ethereum;
      case 'eip155:arbitrum':
        return this.runtimeConfig.rpcUrls[profile].arbitrum;
      case 'eip155:polygon':
        return this.runtimeConfig.rpcUrls[profile].polygon;
      case 'eip155:base':
        return this.runtimeConfig.rpcUrls[profile].base;
    }
  }

  private buildRuntimeConfig(): RuntimeConfig {
    return {
      networkProfile: parseRuntimeNetworkProfile('HUB_NETWORK_PROFILE'),
      authoritySignerMnemonic: readEnv('SIGNER_MNEMONIC', readEnv('ACCOUNT_MNEMONIC', '')),
      rpcUrls: {
        testnet: {
          ethereum: readEnv('TESTNET_ETHEREUM_RPC_URL', 'https://rpc.sepolia.org'),
          arbitrum: readEnv('TESTNET_ARBITRUM_RPC_URL', 'https://sepolia-rollup.arbitrum.io/rpc'),
          polygon: readEnv('TESTNET_POLYGON_RPC_URL', 'https://rpc-amoy.polygon.technology'),
          base: readEnv('TESTNET_BASE_RPC_URL', 'https://sepolia.base.org'),
        },
        mainnet: {
          ethereum: readEnv('MAINNET_ETHEREUM_RPC_URL', 'https://eth.llamarpc.com'),
          arbitrum: readEnv('MAINNET_ARBITRUM_RPC_URL', 'https://arb1.arbitrum.io/rpc'),
          polygon: readEnv('MAINNET_POLYGON_RPC_URL', 'https://polygon-rpc.com'),
          base: readEnv('MAINNET_BASE_RPC_URL', 'https://mainnet.base.org'),
        },
      },
    };
  }
}
