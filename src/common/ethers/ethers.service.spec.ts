import { EthersService } from './ethers.service.js';
import { ethers } from 'ethers';

describe('EthersService', () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const config = {
    getEthMode: () => 'testnet',
    getAccountMnemonic: () => mnemonic,
    getAlchemyApiKey: (network: string) => {
      const values: Record<string, string> = {
        base: '',
        ethereum: '',
        arbitrum: '',
        polygon: '',
      };
      return values[network];
    },
  };

  let service: EthersService;

  beforeEach(() => {
    service = new EthersService(config as any);
    service.onModuleInit();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('signs and verifies messages', async () => {
    const message = 'hello';
    const signature = await service.signMessage(message);
    const recovered = service.verifyMessage(message, signature);

    expect(ethers.isAddress(recovered)).toBe(true);
  });

  it('creates lockable contract instance for base network', () => {
    const contract = service.getContract('IERC721Lockable', 'eip155:base', '0x1234567890123456789012345678901234567890');
    expect(contract).toBeInstanceOf(ethers.Contract);
  });

  it('throws on unknown network', () => {
    expect(() => service.getContract('IERC721Lockable', 'unknown', '0x1234567890123456789012345678901234567890')).toThrow(
      /Incorrect network name/,
    );
  });
});
