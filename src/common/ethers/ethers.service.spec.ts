import { Test, TestingModule } from '@nestjs/testing';
import { ethers } from 'ethers';
import { ConfigService, EvmNetworkName, RuntimeNetworkProfile } from '../config/config.service.js';
import { EthersModule } from './ethers.module.js';
import { EthersService } from './ethers.service.js';
import { ETHERS_RPC_PROVIDER_FACTORY, EthersRpcProviderFactory } from './ethers.tokens.js';

describe('EthersService', () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const rpcUrls: Record<RuntimeNetworkProfile, Record<EvmNetworkName, string>> = {
    testnet: {
      'eip155:ethereum': 'https://ethereum-sepolia.example.test',
      'eip155:arbitrum': 'https://arbitrum-sepolia.example.test',
      'eip155:polygon': 'https://polygon-amoy.example.test',
      'eip155:base': 'https://base-sepolia.example.test',
    },
    mainnet: {
      'eip155:ethereum': 'https://ethereum-mainnet.example.test',
      'eip155:arbitrum': 'https://arbitrum-mainnet.example.test',
      'eip155:polygon': 'https://polygon-mainnet.example.test',
      'eip155:base': 'https://base-mainnet.example.test',
    },
  };

  let module: TestingModule;
  let service: EthersService;
  let providerFactory: jest.MockedFunction<EthersRpcProviderFactory>;
  let createdProviders: Array<{
    rpcUrl: string;
    network: { name: string; chainId: number };
    provider: ethers.JsonRpcProvider;
  }>;

  const createModule = async (profile: RuntimeNetworkProfile): Promise<void> => {
    createdProviders = [];
    providerFactory = jest.fn((rpcUrl: string, network: { name: string; chainId: number }) => {
      const provider = new ethers.JsonRpcProvider(rpcUrl, network);
      jest.spyOn(provider, 'destroy');
      createdProviders.push({ rpcUrl, network, provider });
      return provider;
    }) as jest.MockedFunction<EthersRpcProviderFactory>;

    const config = {
      getRuntimeNetworkProfile: jest.fn(() => profile),
      getAuthoritySignerPrivateKey: jest.fn(() => ''),
      getAuthoritySignerMnemonic: jest.fn(() => mnemonic),
      getRpcUrl: jest.fn((requestedProfile: RuntimeNetworkProfile, network: EvmNetworkName) => rpcUrls[requestedProfile][network]),
    };

    module = await Test.createTestingModule({
      imports: [EthersModule],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(ETHERS_RPC_PROVIDER_FACTORY)
      .useValue(providerFactory)
      .compile();
    await module.init();
    service = module.get<EthersService>(EthersService);
  };

  afterEach(async () => {
    await module?.close();
  });

  it('initializes Base through the factory with the exact testnet resolution', async () => {
    await createModule('testnet');

    expect(service).toBeDefined();
    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(providerFactory).toHaveBeenCalledWith(rpcUrls.testnet['eip155:base'], {
      name: 'base-sepolia',
      chainId: 84532,
    });
  });

  it('retains exact Base provider identity across repeated contract lookups', async () => {
    await createModule('testnet');

    const initialProvider = createdProviders[0].provider;
    const firstContract = service.getContract('IERC721Lockable', 'eip155:base', '0x1234567890123456789012345678901234567890');
    const secondContract = service.getContract('IERC721Lockable', 'eip155:base', '0x1234567890123456789012345678901234567890');

    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect((firstContract.runner as ethers.Wallet).provider).toBe(initialProvider);
    expect((secondContract.runner as ethers.Wallet).provider).toBe(initialProvider);
  });

  it('caches a distinct second supported network using its exact resolved inputs', async () => {
    await createModule('testnet');

    const baseProvider = createdProviders[0].provider;
    const firstContract = service.getContract('IERC721Lockable', 'eip155:ethereum', '0x1234567890123456789012345678901234567890');
    const secondContract = service.getContract('IERC721Lockable', 'eip155:ethereum', '0x1234567890123456789012345678901234567890');

    expect(providerFactory).toHaveBeenCalledTimes(2);
    expect(providerFactory).toHaveBeenLastCalledWith(rpcUrls.testnet['eip155:ethereum'], {
      name: 'sepolia',
      chainId: 11155111,
    });
    expect((firstContract.runner as ethers.Wallet).provider).toBe(createdProviders[1].provider);
    expect((secondContract.runner as ethers.Wallet).provider).toBe(createdProviders[1].provider);
    expect(createdProviders[1].provider).not.toBe(baseProvider);
  });

  it('retains exact mainnet profile resolution', async () => {
    await createModule('mainnet');

    expect(providerFactory).toHaveBeenCalledWith(rpcUrls.mainnet['eip155:base'], {
      name: 'base',
      chainId: 8453,
    });
  });

  it('preserves signer verification and contract construction', async () => {
    await createModule('testnet');

    const message = 'hello';
    const signature = await service.signMessage(message);
    const recovered = service.verifyMessage(message, signature);

    expect(ethers.isAddress(recovered)).toBe(true);
    const contract = service.getContract('IERC721Lockable', 'eip155:base', '0x1234567890123456789012345678901234567890');
    expect(contract).toBeInstanceOf(ethers.Contract);
  });

  it('rejects unsupported networks before invoking the factory', async () => {
    await createModule('testnet');
    const factoryCalls = providerFactory.mock.calls.length;

    expect(() => service.getContract('IERC721Lockable', 'unknown', '0x1234567890123456789012345678901234567890')).toThrow(
      /Incorrect network name/,
    );
    expect(providerFactory).toHaveBeenCalledTimes(factoryCalls);
  });

  it('destroys each cached provider exactly once when the Nest module closes', async () => {
    await createModule('testnet');
    service.getContract('IERC721Lockable', 'eip155:ethereum', '0x1234567890123456789012345678901234567890');

    await module.close();
    await module.close();

    expect(createdProviders).toHaveLength(2);
    for (const { provider } of createdProviders) {
      expect(provider.destroy).toHaveBeenCalledTimes(1);
    }
  });
});
