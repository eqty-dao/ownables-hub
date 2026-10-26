import { Test, TestingModule } from '@nestjs/testing';
import { ethers } from 'ethers';
import { ConfigService, EvmNetworkName, RuntimeNetworkProfile } from '../config/config.service';
import { EthersModule } from './ethers.module';
import { EthersService } from './ethers.service';
import { ETHERS_RPC_PROVIDER_FACTORY, EthersRpcProviderFactory } from './ethers.tokens';

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

  it('caches a distinct second wallet network using its exact resolved inputs', async () => {
    await createModule('testnet');

    const baseProvider = createdProviders[0].provider;
    const ethereumProvider = new ethers.JsonRpcProvider(rpcUrls.testnet['eip155:ethereum'], {
      name: 'sepolia',
      chainId: 11155111,
    });
    jest.spyOn(ethereumProvider, 'getBalance').mockResolvedValue(0n);
    jest.spyOn(ethereumProvider, 'destroy');
    providerFactory.mockImplementationOnce(() => ethereumProvider);
    await service.getHubWallet('eip155:ethereum');
    await service.getHubWallet('eip155:ethereum');

    expect(providerFactory).toHaveBeenCalledTimes(2);
    expect(providerFactory).toHaveBeenLastCalledWith(rpcUrls.testnet['eip155:ethereum'], {
      name: 'sepolia',
      chainId: 11155111,
    });
    expect(ethereumProvider).not.toBe(baseProvider);
  });

  it('retains exact mainnet profile resolution', async () => {
    await createModule('mainnet');

    expect(providerFactory).toHaveBeenCalledWith(rpcUrls.mainnet['eip155:base'], {
      name: 'base',
      chainId: 8453,
    });
  });

  it.each([
    ['testnet', 'eip155:ethereum', 'eip155:11155111', 'ETH'],
    ['testnet', 'eip155:arbitrum', 'eip155:421614', 'ETH'],
    ['testnet', 'eip155:polygon', 'eip155:80002', 'POL'],
    ['testnet', 'eip155:base', 'eip155:84532', 'ETH'],
    ['mainnet', 'eip155:ethereum', 'eip155:1', 'ETH'],
    ['mainnet', 'eip155:arbitrum', 'eip155:42161', 'ETH'],
    ['mainnet', 'eip155:polygon', 'eip155:137', 'POL'],
    ['mainnet', 'eip155:base', 'eip155:8453', 'ETH'],
  ] as const)('returns a public wallet response for %s %s', async (profile, network, networkId, unit) => {
    await createModule(profile);
    const provider = service['getProviderForNetwork'](network);
    jest.spyOn(provider, 'getBalance').mockResolvedValue(1250000000000000000n);

    await expect(service.getHubWallet(network)).resolves.toEqual({
      address: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
      networkId,
      balance: '1.25',
      unit,
    });
  });

  it('rejects unsupported wallet networks before creating a provider', async () => {
    await createModule('testnet');
    const factoryCalls = providerFactory.mock.calls.length;

    await expect(service.getHubWallet('eip155:unknown')).rejects.toThrow(/Incorrect network name/);
    expect(providerFactory).toHaveBeenCalledTimes(factoryCalls);
  });

  it('destroys each cached provider exactly once when the Nest module closes', async () => {
    await createModule('testnet');
    const ethereumProvider = new ethers.JsonRpcProvider(rpcUrls.testnet['eip155:ethereum'], {
      name: 'sepolia',
      chainId: 11155111,
    });
    jest.spyOn(ethereumProvider, 'destroy');
    jest.spyOn(ethereumProvider, 'getBalance').mockResolvedValue(0n);
    providerFactory.mockImplementationOnce(() => ethereumProvider);
    await service.getHubWallet('eip155:ethereum');

    await module.close();
    await module.close();

    expect(createdProviders).toHaveLength(1);
    expect(createdProviders[0].provider.destroy).toHaveBeenCalledTimes(1);
    expect(ethereumProvider.destroy).toHaveBeenCalledTimes(1);
  });
});
