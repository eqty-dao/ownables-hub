import { readBaseConfigForStartBlock } from './base-config.mjs';

async function rpc(url, method, params = []) {
  let result;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    ({ result } = await response.json());
    if (result == null) throw new Error();
  } catch {
    throw new Error(`Could not get ${method} from the configured Base RPC`);
  }
  return result;
}

try {
  const { chainId, rpcUrl, anchor, startBlockVariable } = readBaseConfigForStartBlock(process.argv[2]);
  const rpcChainId = await rpc(rpcUrl, 'eth_chainId');
  if (BigInt(rpcChainId) !== BigInt(chainId)) {
    throw new Error(`Configured RPC does not serve Base chain ${chainId}`);
  }

  const block = await rpc(rpcUrl, 'eth_getBlockByNumber', ['finalized', false]);
  if (!/^0x[0-9a-f]+$/i.test(block.number ?? '') || BigInt(block.number) <= 0n) {
    throw new Error('Base RPC did not return a positive finalized block number');
  }
  const code = await rpc(rpcUrl, 'eth_getCode', [anchor, block.number]);
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(code)) {
    throw new Error(`No deployed Anchor code at finalized block ${BigInt(block.number)}`);
  }

  console.log(`${startBlockVariable}=${BigInt(block.number)}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
