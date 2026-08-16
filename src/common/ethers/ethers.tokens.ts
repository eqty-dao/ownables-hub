import type { ethers } from 'ethers';

export const ETHERS_RPC_PROVIDER_FACTORY = Symbol('ETHERS_RPC_PROVIDER_FACTORY');
export type EthersRpcProviderFactory = (
  rpcUrl: string,
  network: { name: string; chainId: number },
) => ethers.JsonRpcProvider;
