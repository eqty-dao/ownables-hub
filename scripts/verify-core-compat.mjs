import { AnchorValidationService, OwnablePackageCidService, PublicEventReplayService } from '@ownables/core';
import { NodeRuntimeRpcProvider, NodeRuntimeSourceProvider } from '@ownables/platform-node';
import { Event, EventChain } from 'eqty-core';
import { ethers } from 'ethers';

async function main() {
  const cid = await new OwnablePackageCidService().calculate([
    { path: 'package.json', content: Buffer.from('{"name":"compat"}') },
    { path: 'index.html', content: Buffer.from('<h1>compat</h1>') },
  ]);

  if (typeof cid !== 'string' || cid.length === 0) {
    throw new Error('Failed to compute CID from @ownables/core package root import');
  }

  const services = [
    new AnchorValidationService(),
    new PublicEventReplayService(),
    new NodeRuntimeSourceProvider(),
    new NodeRuntimeRpcProvider(),
  ];
  if (services.some((service) => typeof service !== 'object')) throw new Error('Failed to construct service API');

  const wallet = ethers.Wallet.createRandom();
  const chain = EventChain.create(wallet.address, 84532);
  const event = new Event({
    '@context': 'instantiate_msg.json',
    nft: { network: 'eip155:base', address: '0xabc', id: '1' },
  });

  await event
    .addTo(chain)
    .signWith({
      getAddress: async () => wallet.address,
      signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value),
    });

  if (!event.signature || !event.signerAddress || chain.events.length !== 1) {
    throw new Error('Failed to create/sign EventChain via eqty-core package root import');
  }

  console.log(
    JSON.stringify({
      cid,
      signer: event.signerAddress,
      events: chain.events.length,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
