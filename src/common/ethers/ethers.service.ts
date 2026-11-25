import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService, HubNetwork, HubNetworkContext } from '../config/config.service';
import { ETHERS_RPC_PROVIDER_FACTORY, EthersRpcProviderFactory } from './ethers.tokens';

@Injectable()
export class EthersService implements OnModuleInit, OnModuleDestroy {
  private signer: ethers.HDNodeWallet | ethers.Wallet;
  private readonly providers = new Map<HubNetwork, ethers.JsonRpcProvider>();

  constructor(
    private readonly config: ConfigService,
    @Inject(ETHERS_RPC_PROVIDER_FACTORY) private readonly providerFactory: EthersRpcProviderFactory,
  ) {}

  onModuleInit(): void {
    this.signer = this.createSigner();
  }

  onModuleDestroy(): void {
    const providers = new Set(this.providers.values());
    this.providers.clear();

    for (const provider of providers) {
      provider.destroy();
    }
  }

  public async getHubWallet(network: HubNetworkContext): Promise<{
    address: string;
    networkId: string;
    balance: string;
    unit: 'ETH' | 'POL';
  }> {
    const provider = this.getProvider(network);
    return {
      address: this.signer.address,
      networkId: network.caip2,
      balance: ethers.formatUnits(await provider.getBalance(this.signer.address), 'ether'),
      unit: 'ETH',
    };
  }

  private getProvider(network: HubNetworkContext): ethers.JsonRpcProvider {
    const cachedProvider = this.providers.get(network.slug);
    if (cachedProvider) {
      return cachedProvider;
    }

    const provider = this.providerFactory(network.rpcUrl, {
      name: network.slug,
      chainId: Number(network.chainId),
    });
    this.providers.set(network.slug, provider);
    return provider;
  }

  private createSigner(): ethers.HDNodeWallet | ethers.Wallet {
    const privateKey = this.config.getAuthoritySignerPrivateKey();
    if (privateKey) {
      return new ethers.Wallet(privateKey);
    }

    const mnemonic = this.config.getAuthoritySignerMnemonic();
    if (mnemonic) {
      return ethers.Wallet.fromPhrase(mnemonic);
    }

    return new ethers.Wallet(ethers.id('ownables-hub-fallback-key'));
  }
}
