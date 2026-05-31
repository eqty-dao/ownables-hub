import JSZip from 'jszip';
import { ethers } from 'ethers';
import { Event, EventChain } from '../test-mocks/eqty-core.js';
import { OwnableService } from './ownable.service.js';

jest.mock('@ownables/core', () => ({
  calculateOwnablePackageCid: (entries: Array<{ path: string; content: Buffer }>) =>
    `cid-${entries.map((entry) => entry.path).sort().join('-')}`,
  evaluateReplayFreshness: jest.fn(() => ({ stale: false, missingReplayKeys: [] })),
  publicEventReplayKey: ({ transactionHash, logIndex }: { transactionHash: string; logIndex: number }) =>
    `${transactionHash}:${logIndex}`,
}));
jest.mock('eqty-core', () => require('../test-mocks/eqty-core.ts'));

describe('OwnableService', () => {
  const ownerWallet = ethers.Wallet.createRandom();

  const buildConfig = () => ({
    getRuntimeNetworkProfile: () => 'testnet',
    getAuthoritySignerMnemonic: () => ownerWallet.mnemonic?.phrase || '',
  });

  const buildService = async () => {
    const nft = {
      getOwnerOfNFT: jest.fn().mockResolvedValue(ownerWallet.address),
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
      getOwnableByCid: jest.fn().mockResolvedValue({ id: 'id-1', cid: 'cid-1' }),
      getOwnableByNft: jest.fn(),
      listOwnableCidsByPrevOwner: jest.fn().mockResolvedValue(['cid-a']),
      listWalletEventsByCid: jest.fn().mockResolvedValue([]),
    };

    const service = new OwnableService(
      buildConfig() as any,
      { load: jest.fn() } as any,
      nft as any,
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

  it('accepts upload without SIWE signer ownership gating', async () => {
    const { service, storage, hubState, nft } = await buildService();
    const chain = await createChain();

    const zip = new JSZip();
    zip.file('eventChain.json', JSON.stringify(chain.toJSON()));
    zip.file('package.json', JSON.stringify({ name: 'test' }));
    const buffer = await zip.generateAsync({ type: 'uint8array' });

    const result = await service.uploadOwnable(buffer, undefined, false);

    expect(result.cid).toEqual(expect.any(String));
    expect(storage.storePackageArtifacts).toHaveBeenCalledTimes(1);
    expect(storage.storeEventChain).toHaveBeenCalledTimes(1);
    expect(hubState.upsertOwnableRecord).toHaveBeenCalledTimes(1);
    expect(nft.getOwnerOfNFT).not.toHaveBeenCalled();
  });

  it('downloads using replay-derived owner state and persists last applied event pointer', async () => {
    const { service, storage, hubState } = await buildService();

    storage.getPackageZip.mockResolvedValue(await new JSZip().generateAsync({ type: 'nodebuffer' }));
    storage.getEventChain.mockResolvedValue(Buffer.from(JSON.stringify((await createChain()).toJSON()), 'utf8'));

    jest.spyOn(service as any, 'replayStoredOwnable').mockResolvedValue({
      nftInfo: { network: 'eip155:base', address: '0xabc', id: '1' },
      owner: ownerWallet.address.toLowerCase(),
      latestAppliedPublicEventId: 'evt-1',
    });

    await service.downloadOwnable('cid-1');

    expect(hubState.setOwnerState).toHaveBeenCalledWith('id-1', ownerWallet.address.toLowerCase(), 'evt-1');
  });

  it('rejects stale ownables through stable stale error contract', async () => {
    const { service } = await buildService();
    jest.spyOn(service as any, 'replayStoredOwnable').mockRejectedValue(new Error('STALE_OWNABLE missingReplayKeys=0xaaa:1'));
    await expect(service.downloadOwnable('cid-1')).rejects.toThrow('STALE_OWNABLE');
  });

  it('requires signer for unlock proof', async () => {
    const { service } = await buildService();
    await expect(service.getUnlockProof('cid-1')).rejects.toThrow('Missing SIWE signer');
  });
});
