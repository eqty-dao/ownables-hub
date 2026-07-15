import type { JsonRpcProvider } from 'ethers';
import type { IndexerSlotConfig } from '../common/config/config.service.js';

export const EVM_RPC_PROVIDER_FACTORY = Symbol('EVM_RPC_PROVIDER_FACTORY');
export type EvmRpcProviderFactory = (slot: IndexerSlotConfig) => JsonRpcProvider;
