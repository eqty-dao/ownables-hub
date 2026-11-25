const BASE_NETWORKS = {
  base: { chainId: '8453', envPrefix: 'MAINNET', slotName: 'mainnet' },
  'base-sepolia': { chainId: '84532', envPrefix: 'TESTNET', slotName: 'testnet' },
};

function readRequiredHttpUrl(name) {
  const value = process.env[name];
  if (!URL.canParse(value ?? '') || !['http:', 'https:'].includes(new URL(value).protocol)) {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }
  return value;
}

function readRequiredAnchor(name) {
  const value = process.env[name];
  if (!/^0x[0-9a-f]{40}$/i.test(value ?? '') || /^0x0{40}$/i.test(value)) {
    throw new Error(`${name} must be a deployed, nonzero Anchor address`);
  }
  return value;
}

function readRequiredStartBlock(name) {
  const value = process.env[name];
  if (!/^\d+$/.test(value ?? '') || BigInt(value) === 0n) {
    throw new Error(`${name} must be a positive initialized Base block`);
  }
  return value;
}

export function readEnabledBaseConfigs() {
  return readEnabledNetworks().map((network) => readBaseConfig(network, true));
}

function readEnabledNetworks() {
  const rawNetworks = process.env.INDEXER_NETWORKS ?? 'base-sepolia';
  const networks = rawNetworks.split(',').map((network) => network.trim());
  if (networks.length === 0 || networks.some((network) => !network)) {
    throw new Error('INDEXER_NETWORKS must contain at least one Base network');
  }
  if (new Set(networks).size !== networks.length) {
    throw new Error('INDEXER_NETWORKS must not contain duplicate networks');
  }
  for (const network of networks) {
    if (!Object.hasOwn(BASE_NETWORKS, network)) {
      throw new Error(`Unsupported indexer network: ${network}`);
    }
  }
  return networks;
}

function readBaseConfig(network, requireStartBlock) {
  const definition = BASE_NETWORKS[network];
  const prefix = definition.envPrefix;
  const chainId = process.env[`${prefix}_CHAIN_ID`];
  if (chainId !== definition.chainId) {
    throw new Error(`${prefix}_CHAIN_ID must be ${definition.chainId} for ${network}`);
  }

  const startBlockVariable = `${prefix}_ANCHOR_START_BLOCK`;
  return {
    network,
    slotName: definition.slotName,
    chainId,
    rpcUrl: readRequiredHttpUrl(`${prefix}_RPC_URL`),
    anchor: readRequiredAnchor(`${prefix}_ANCHOR_CONTRACT_ADDR`),
    startBlockVariable,
    startBlock: requireStartBlock ? readRequiredStartBlock(startBlockVariable) : undefined,
  };
}

export function readBaseConfigForStartBlock(network) {
  const enabled = readEnabledNetworks();
  if (!network) {
    if (enabled.length === 1) return readBaseConfig(enabled[0], false);
    throw new Error('Pass a Base network when selecting a start block for multiple enabled indexers');
  }

  if (!enabled.includes(network)) {
    throw new Error(`Network ${network} is not enabled in INDEXER_NETWORKS`);
  }
  return readBaseConfig(network, false);
}
