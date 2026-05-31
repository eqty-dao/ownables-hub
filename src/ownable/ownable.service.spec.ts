import JSZip from 'jszip';
import { ethers } from 'ethers';
import { Event, EventChain } from '../test-mocks/eqty-core.js';
import { OwnableService } from './ownable.service.js';

jest.mock('@ownables/core', () => ({
  calculateOwnablePackageCid: (entries: Array<{ path: string; content: Buffer }>) =>
    `cid-${entries.map((entry) => entry.path).sort().join('-')}`,
}));
jest.mock('eqty-core', () => require('../test-mocks/eqty-core.ts'));

describe('OwnableService', () => {
  const ownerWallet = ethers.Wallet.createRandom();

  const buildConfig = () => ({
    getRuntimeNetworkProfile: () => 'testnet',
    getAuthoritySignerMnemonic: () => ownerWallet.mnemonic?.phrase || '',
  });

  const buildService = async (nftOwner = ownerWallet.address) => {
    const nft = {
      getOwnerOfNFT: jest.fn().mockResolvedValue(nftOwner),
      isNFTlocked: jest.fn().mockResolvedValue(true),
      getUnlockProof: jest.fn().mockResolvedValue('unlock-proof'),
      isUnlockProofValid: jest.fn().mockResolvedValue(true),
      getNFTcount: jest.fn().mockResolvedValue('42'),
      GetServerETHBalance: jest.fn().mockResolvedValue('1.00'),
    };
    const storage = {
      storePackageArtifacts: jest.fn().mockResolvedValue(undefined),
      storeEventChain: jest.fn().mockResolvedValue(undefined),
      hasEventChain: jest.fn().mockResolvedValue(true),
      hasPackage: jest.fn().mockResolvedValue(true),
      getEventChain: jest.fn(),
      getPackageZip: jest.fn(),
    };
    const hubState = {
      upsertOwnableRecord: jest.fn().mockResolvedValue({ id: 'id-1' }),
      setOwnerState: jest.fn().mockResolvedValue(undefined),
      getOwnableByCid: jest.fn(),
      getOwnableByNft: jest.fn(),
      listOwnableCidsByPrevOwner: jest.fn().mockResolvedValue(['cid-a']),
    };

    const service = new OwnableService(
      {} as any,
      buildConfig() as any,
      {} as any,
      nft as any,
      {} as any,
      storage as any,
      hubState as any,
    );

    await service.onModuleInit();
    return { service, nft, storage, hubState };
  };

  const createChain = async (nft = { network: 'eip155:base', address: '0xabc', id: '1' }) => {
    const chain = new EventChain(`0x${'11'.repeat(32)}`);
    const signer = {
      getAddress: async () => ownerWallet.address,
      signTypedData: async () => `0x${'00'.repeat(65)}`,
    };
    const event = new Event({ '@context': 'instantiate_msg.json', nft });
    event.previous = {
      toHex: () => `0x${'12'.repeat(32)}`,
    } as any;
    await event.addTo(chain).signWith(signer);
    return chain;
  };

  it('stores bridge metadata in postgres repository and bucket', async () => {
    const { service, storage, hubState } = await buildService();
    const chain = await createChain();

    const zip = new JSZip();
    zip.file('eventChain.json', JSON.stringify(chain.toJSON()));
    zip.file('package.json', JSON.stringify({ name: 'test' }));
    const buffer = await zip.generateAsync({ type: 'uint8array' });

    const result = await service.bridgeOwnable(buffer, { address: ownerWallet.address }, false);

    expect(result.cid).toEqual(expect.any(String));
    expect(storage.storePackageArtifacts).toHaveBeenCalledTimes(1);
    expect(storage.storeEventChain).toHaveBeenCalledTimes(1);
    expect(hubState.upsertOwnableRecord).toHaveBeenCalledTimes(1);
    expect(hubState.setOwnerState).toHaveBeenCalledWith('id-1', ownerWallet.address);
  });

  it('reads bridged cid list from postgres repository', async () => {
    const { service, hubState } = await buildService();
    const cids = await service.getBridgedOwnableCIDs({ address: ownerWallet.address });
    expect(cids).toEqual(['cid-a']);
    expect(hubState.listOwnableCidsByPrevOwner).toHaveBeenCalledWith(ownerWallet.address.toLowerCase());
  });

  it('rejects claim when signer is not nft owner', async () => {
    const { service, storage } = await buildService(ethers.Wallet.createRandom().address);
    const chain = await createChain();

    const zip = new JSZip();
    zip.file('package.json', '{}');

    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify(chain.toJSON()), 'utf8'));
    storage.getPackageZip.mockResolvedValue(await zip.generateAsync({ type: 'nodebuffer' }));

    await expect(service.claimOwnable('cid-1', { address: ownerWallet.address })).rejects.toThrow('is not current NFT owner');
  });
});
