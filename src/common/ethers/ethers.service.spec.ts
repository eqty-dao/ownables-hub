import { Test, TestingModule } from '@nestjs/testing';
import { ethers } from 'ethers';
import { ConfigService, HubNetworkContext } from '../config/config.service';
import { EthersModule } from './ethers.module';
import { EthersService } from './ethers.service';
import { ETHERS_RPC_PROVIDER_FACTORY, EthersRpcProviderFactory } from './ethers.tokens';

describe('EthersService', () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const base: HubNetworkContext = {
    slug: 'base',
    caip2: 'eip155:8453',
    chainId: '8453',
    slotName: 'mainnet',
    rpcUrl: 'https://base.example.test',
  };
  const baseSepolia: HubNetworkContext = {
    slug: 'base-sepolia',
    caip2: 'eip155:84532',
    chainId: '84532',
    slotName: 'testnet',
    rpcUrl: 'https://base-sepolia.example.test',
  };

  let module: TestingModule;
  let service: EthersService;
  let providerFactory: jest.MockedFunction<EthersRpcProviderFactory>;
  let createdProviders: Array<{
    rpcUrl: string;
    network: { name: string; chainId: number };
    provider: ethers.JsonRpcProvider;
  }>;

  const createModule = async (): Promise<void> => {
    createdProviders = [];
    providerFactory = jest.fn((rpcUrl: string, network: { name: string; chainId: number }) => {
      const provider = new ethers.JsonRpcProvider(rpcUrl, network);
      jest.spyOn(provider, 'destroy');
      jest.spyOn(provider, 'getBalance').mockResolvedValue(1250000000000000000n);
      createdProviders.push({ rpcUrl, network, provider });
      return provider;
    }) as jest.MockedFunction<EthersRpcProviderFactory>;

    module = await Test.createTestingModule({
      imports: [EthersModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        getAuthoritySignerPrivateKey: jest.fn(() => ''),
        getAuthoritySignerMnemonic: jest.fn(() => mnemonic),
      })
      .overrideProvider(ETHERS_RPC_PROVIDER_FACTORY)
      .useValue(providerFactory)
      .compile();
    await module.init();
    service = module.get<EthersService>(EthersService);
  };

  afterEach(async () => {
    await module?.close();
  });

  it('does not bind the signer to a startup network', async () => {
    await createModule();

    expect(service).toBeDefined();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('caches an independent provider for each Base network', async () => {
    await createModule();

    await service.getHubWallet(baseSepolia);
    await service.getHubWallet(baseSepolia);
    await service.getHubWallet(base);

    expect(providerFactory).toHaveBeenCalledTimes(2);
    expect(createdProviders.map(({ rpcUrl, network }) => ({ rpcUrl, network }))).toEqual([
      { rpcUrl: baseSepolia.rpcUrl, network: { name: 'base-sepolia', chainId: 84532 } },
      { rpcUrl: base.rpcUrl, network: { name: 'base', chainId: 8453 } },
    ]);
  });

  it.each([base, baseSepolia])('returns the public wallet response for $slug', async (network) => {
    await createModule();

    await expect(service.getHubWallet(network)).resolves.toEqual({
      address: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
      networkId: network.caip2,
      balance: '1.25',
      unit: 'ETH',
    });
  });

  it('destroys every cached Base provider when the Nest module closes', async () => {
    await createModule();
    await service.getHubWallet(base);
    await service.getHubWallet(baseSepolia);

    await module.close();
    await module.close();

    for (const { provider } of createdProviders) {
      expect(provider.destroy).toHaveBeenCalledTimes(1);
    }
  });
});
