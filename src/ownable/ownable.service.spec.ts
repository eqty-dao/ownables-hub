import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import JSZip from 'jszip';
import { ethers } from 'ethers';
import { Binary, Event, EventChain } from '../test-mocks/eqty-core.js';
import { OwnableService } from './ownable.service.js';

jest.mock('@ownables/core', () => ({
  calculateOwnablePackageCid: (entries: Array<{ path: string; content: Buffer }>) =>
    `cid-${entries.map((entry) => entry.path).sort().join('-')}`,
}));
jest.mock('eqty-core', () => require('../test-mocks/eqty-core.ts'));

describe('OwnableService', () => {
  const ownerWallet = ethers.Wallet.createRandom();

  const buildConfig = (root: string) => ({
    getStoragePaths: () => ({
      packages: path.join(root, 'packages'),
      chains: path.join(root, 'chains'),
      users: path.join(root, 'users'),
      nfts: path.join(root, 'nfts'),
    }),
    getAuthoritySignerMnemonic: () => ownerWallet.mnemonic?.phrase || '',
    getBaseNftContractAddress: () => '0xbaseSepolia',
  });

  const buildService = async (root: string, nftOwner = ownerWallet.address) => {
    const nft = {
      getOwnerOfNFT: jest.fn().mockResolvedValue(nftOwner),
      isNFTlocked: jest.fn().mockResolvedValue(true),
      getUnlockProof: jest.fn().mockResolvedValue('unlock-proof'),
      isUnlockProofValid: jest.fn().mockResolvedValue(true),
      getNFTcount: jest.fn().mockResolvedValue('42'),
      GetServerETHBalance: jest.fn().mockResolvedValue('1.00'),
    };

    const service = new OwnableService(
      {} as any,
      buildConfig(root) as any,
      {} as any,
      nft as any,
      {} as any,
    );

    await service.onModuleInit();
    return { service, nft };
  };

  const createChain = async (nft = { network: 'eip155:base', address: '0xabc', id: '1' }) => {
    const chain = new EventChain(`0x${'11'.repeat(32)}`);
    const signer = {
      getAddress: async () => ownerWallet.address,
      signTypedData: async () => `0x${'00'.repeat(65)}`,
    };
    const event = new Event({ '@context': 'instantiate_msg.json', nft });
    event.previous = Binary.fromHex(ethers.keccak256(ethers.toUtf8Bytes(chain.id)).slice(2));
    await event.addTo(chain).signWith(signer);
    return chain;
  };

  it('stores bridged ownable metadata for the SIWE owner', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hub-ownable-'));
    const { service } = await buildService(root);
    const chain = await createChain();

    const zip = new JSZip();
    zip.file('eventChain.json', JSON.stringify(chain.toJSON()));
    zip.file('package.json', JSON.stringify({ name: 'test' }));
    const buffer = await zip.generateAsync({ type: 'uint8array' });

    const result = await service.bridgeOwnable(buffer, { address: ownerWallet.address }, false);

    expect(result.cid).toEqual(expect.any(String));
    const usersDir = path.join(root, 'users');
    const files = readFileSync(path.join(usersDir, `${result.cid}_${ownerWallet.address.toLowerCase()}_bridged`), 'utf8');
    expect(JSON.parse(files).owner).toEqual(ownerWallet.address);

    await rm(root, { recursive: true, force: true });
  });

  it('rejects claim when signer is not current NFT owner', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hub-ownable-'));
    const { service } = await buildService(root, ethers.Wallet.createRandom().address);

    const chain = await createChain();
    const chainsDir = path.join(root, 'chains', 'cid-1');
    const pkgDir = path.join(root, 'packages', 'cid-1');
    await mkdir(chainsDir, { recursive: true });
    await mkdir(pkgDir, { recursive: true });

    writeFileSync(path.join(chainsDir, 'eventChain.json'), JSON.stringify(chain.toJSON()));
    const zip = new JSZip();
    zip.file('package.json', '{}');
    writeFileSync(path.join(pkgDir, 'cid-1.zip'), await zip.generateAsync({ type: 'uint8array' }));

    await expect(service.claimOwnable('cid-1', { address: ownerWallet.address })).rejects.toThrow('is not current NFT owner');

    await rm(root, { recursive: true, force: true });
  });

  it('lists bridged ownable CIDs for the provided signer', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hub-ownable-'));
    const { service } = await buildService(root);

    const usersDir = path.join(root, 'users');
    writeFileSync(path.join(usersDir, `cid-a_${ownerWallet.address.toLowerCase()}_bridged`), '{}');
    writeFileSync(path.join(usersDir, `cid-b_${ownerWallet.address.toLowerCase()}_bridged`), '{}');
    writeFileSync(path.join(usersDir, `cid-c_0xother_bridged`), '{}');

    expect(service.getBridgedOwnableCIDs({ address: ownerWallet.address }).sort()).toEqual(['cid-a', 'cid-b']);

    await rm(root, { recursive: true, force: true });
  });
});
