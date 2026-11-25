const baseChainIds = { mainnet: '8453', testnet: '84532' };

export function readActiveBaseConfig() {
  const profile = process.env.HUB_NETWORK_PROFILE;
  if (profile !== 'mainnet' && profile !== 'testnet') {
    throw new Error('HUB_NETWORK_PROFILE must be mainnet or testnet');
  }

  const prefix = profile.toUpperCase();
  const chainId = process.env[`${prefix}_CHAIN_ID`];
  if (chainId !== baseChainIds[profile]) {
    throw new Error(`${prefix}_CHAIN_ID must be ${baseChainIds[profile]} for Base`);
  }

  const rpcUrl = process.env[`${prefix}_RPC_URL`];
  if (!URL.canParse(rpcUrl ?? '') || !['http:', 'https:'].includes(new URL(rpcUrl).protocol)) {
    throw new Error(`${prefix}_RPC_URL must be an HTTP(S) URL`);
  }

  const anchor = process.env[`${prefix}_ANCHOR_CONTRACT_ADDR`];
  if (!/^0x[0-9a-f]{40}$/i.test(anchor ?? '') || /^0x0{40}$/i.test(anchor)) {
    throw new Error(`${prefix}_ANCHOR_CONTRACT_ADDR must be a deployed, nonzero Anchor address`);
  }

  return { chainId, rpcUrl, anchor, startBlockVariable: `${prefix}_ANCHOR_START_BLOCK` };
}
