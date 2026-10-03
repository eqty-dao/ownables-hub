import { EthereumService } from './ethereum.service';
import { NFTInfo } from '../../interfaces/OwnableInfo';

describe('EthereumService', () => {
  let service: EthereumService;
  const ethersService = {
    getContract: jest.fn(),
    signMessage: jest.fn(),
  };

  beforeEach(() => {
    service = new EthereumService(ethersService as any);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return unlock proof', async () => {
    const nft: NFTInfo = {
      network: 'eip155:base',
      address: '0x123',
      id: '456',
    };
    const dummyContract = {
      unlockChallenge: jest.fn().mockResolvedValue('challenge'),
    };
    ethersService.getContract.mockReturnValue(dummyContract);
    ethersService.signMessage.mockResolvedValue('unlock-proof');

    const unlockProof = await service.getUnlockProof(nft);

    expect(ethersService.getContract).toHaveBeenCalledWith('LockableNFT', nft.network, nft.address);
    expect(dummyContract.unlockChallenge).toHaveBeenCalledWith(nft.id);
    expect(ethersService.signMessage).toHaveBeenCalledWith('challenge');
    expect(unlockProof).toBe('unlock-proof');
  });
});
