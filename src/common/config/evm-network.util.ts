import type { EvmNetworkName, RuntimeNetworkProfile } from './config.service.js';

export interface ResolvedEvmNetwork {
  rpcName: string;
  chainId: number;
}

const NETWORK_MATRIX: Record<EvmNetworkName, Record<RuntimeNetworkProfile, ResolvedEvmNetwork>> = {
  'eip155:ethereum': {
    testnet: { rpcName: 'sepolia', chainId: 11155111 },
    mainnet: { rpcName: 'mainnet', chainId: 1 },
  },
  'eip155:arbitrum': {
    testnet: { rpcName: 'arbitrum-sepolia', chainId: 421614 },
    mainnet: { rpcName: 'arbitrum', chainId: 42161 },
  },
  'eip155:polygon': {
    testnet: { rpcName: 'matic-amoy', chainId: 80002 },
    mainnet: { rpcName: 'matic', chainId: 137 },
  },
  'eip155:base': {
    testnet: { rpcName: 'base-sepolia', chainId: 84532 },
    mainnet: { rpcName: 'base', chainId: 8453 },
  },
};

export function isSupportedEvmNetworkName(networkName: string): networkName is EvmNetworkName {
  return networkName in NETWORK_MATRIX;
}

export function resolveEvmNetwork(networkName: EvmNetworkName, profile: RuntimeNetworkProfile): ResolvedEvmNetwork {
  return NETWORK_MATRIX[networkName][profile];
}

export function resolveCaip2Reference(networkName: string, profile: RuntimeNetworkProfile): string | null {
  const trimmed = networkName.trim();
  const numericMatch = /^eip155:(\d+)$/.exec(trimmed);
  if (numericMatch) {
    return numericMatch[1] ?? null;
  }

  if (!isSupportedEvmNetworkName(trimmed)) {
    return null;
  }

  return String(resolveEvmNetwork(trimmed, profile).chainId);
}
