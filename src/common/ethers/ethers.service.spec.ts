import { EthersService } from './ethers.service';
import { ethers } from 'ethers';

describe('EthersService', () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const config = {
    get: (key: string) => {
      const values: Record<string, string> = {
        'eth.mode': 'testnet',
        'eth.account.mnemonic': mnemonic,
        'eth.account.base_alchemy_api_key': '',
        'eth.account.eth_alchemy_api_key': '',
        'eth.account.arbitrum_alchemy_api_key': '',
        'eth.account.polygon_alchemy_api_key': '',
      };
      return values[key];
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
    const contract = service.getContract(
      'IERC721Lockable',
      'eip155:base',
      '0x1234567890123456789012345678901234567890',
    );
    expect(contract).toBeInstanceOf(ethers.Contract);
  });

  it('throws on unknown network', () => {
    expect(() =>
      service.getContract('IERC721Lockable', 'unknown', '0x1234567890123456789012345678901234567890'),
    ).toThrow(/Incorrect network name/);
  });
});
