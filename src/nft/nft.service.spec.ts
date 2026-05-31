import { NFTService } from './nft.service.js';
import { NFTInfo } from '../interfaces/OwnableInfo.js';

describe('NFTService', () => {
  let service: NFTService;
  const ethereumService = {
    getUnlockProof: jest.fn(),
    isNFTlocked: jest.fn(),
    getNFTcount: jest.fn(),
    isUnlockProofValid: jest.fn(),
    getOwnerOfNFT: jest.fn(),
    getIssuer: jest.fn(),
    GetServerETHBalance: jest.fn(),
    verifyMessage: jest.fn(),
    testSignMessage: jest.fn(),
  };

  beforeEach(() => {
    service = new NFTService(ethereumService as any);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should call unlock proof for ethereum networks', async () => {
    const nft: NFTInfo = {
      network: 'eip155:base',
      address: '0x123',
      id: '456',
    };
    ethereumService.getUnlockProof.mockResolvedValue('unlock-proof');

    const unlockProof = await service.getUnlockProof(nft);

    expect(ethereumService.getUnlockProof).toHaveBeenCalledWith(nft);
    expect(unlockProof).toBe('unlock-proof');
  });
});
