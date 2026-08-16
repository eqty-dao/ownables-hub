import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService, EvmNetworkName, RuntimeNetworkProfile } from '../config/config.service.js';
import { resolveEvmNetwork } from '../config/evm-network.util.js';
import * as abis from './abi/index.js';
import { ETHERS_RPC_PROVIDER_FACTORY, EthersRpcProviderFactory } from './ethers.tokens.js';

@Injectable()
export class EthersService implements OnModuleInit, OnModuleDestroy {
  private wallet: ethers.Wallet;
  private signer: ethers.HDNodeWallet | ethers.Wallet;
  private networkProfile: RuntimeNetworkProfile;
  private readonly providers = new Map<EvmNetworkName, ethers.JsonRpcProvider>();

  constructor(
    private readonly config: ConfigService,
    @Inject(ETHERS_RPC_PROVIDER_FACTORY) private readonly providerFactory: EthersRpcProviderFactory,
  ) { }

  onModuleInit(): void {
    this.networkProfile = this.config.getRuntimeNetworkProfile();
    const provider = this.getProviderForNetwork('eip155:base');
    this.signer = this.createSigner(provider);
  }

  onModuleDestroy(): void {
    const providers = new Set(this.providers.values());
    this.providers.clear();

    for (const provider of providers) {
      provider.destroy();
    }
  }

  public signMessage(message: string): Promise<string> {
    return this.signer.signMessage(message);
  }

  public verifyMessage(message: string, sig: ethers.SignatureLike): string {
    const recoveredAddress = ethers.verifyMessage(message, sig);
    return recoveredAddress.toString();
  }

  public async testSignMessage(message: string): Promise<string> {
    this.wallet = new ethers.Wallet(ethers.id('foobar'));
    console.log('wallet address:', await this.wallet.getAddress());
    const rawSig = await this.wallet.signMessage(message);
    const sig = ethers.Signature.from(rawSig);
    const recoveredAddress = ethers.verifyMessage(message, sig);
    console.log('recoveredAddress', recoveredAddress);
    console.log('message', message);
    console.log('sig', sig);
    return recoveredAddress.toString();
  }

  public async GetServerETHBalance(networkName: string): Promise<string> {
    const provider = this.getProviderForNetwork(networkName);
    return ethers.formatUnits(await provider.getBalance(this.signer.address), 'ether').toString();
  }

  private getNetwork(networkName: string): {
    name: EvmNetworkName;
    rpcName: string;
    chainId: number;
    rpcUrl: string;
  } {
    const profile = this.networkProfile;
    switch (networkName) {
      case 'eip155:ethereum':
        return this.getResolvedNetwork('eip155:ethereum', profile);
      case 'eip155:arbitrum':
        return this.getResolvedNetwork('eip155:arbitrum', profile);
      case 'eip155:polygon':
        return this.getResolvedNetwork('eip155:polygon', profile);
      case 'eip155:base':
        return this.getResolvedNetwork('eip155:base', profile);
    }
    throw new Error(
      `Incorrect network name. Supported network names: eip155:ethereum eip155:arbitrum eip155:polygon eip155:base`,
    );
  }

  private getResolvedNetwork(networkName: EvmNetworkName, profile: RuntimeNetworkProfile) {
    const resolved = resolveEvmNetwork(networkName, profile);
    return {
      name: networkName,
      rpcName: resolved.rpcName,
      chainId: resolved.chainId,
      rpcUrl: this.config.getRpcUrl(profile, networkName),
    };
  }

  private getProviderForNetwork(networkName: string): ethers.JsonRpcProvider {
    const network = this.getNetwork(networkName);
    const cachedProvider = this.providers.get(network.name);
    if (cachedProvider) {
      return cachedProvider;
    }

    const provider = this.providerFactory(network.rpcUrl, {
      name: network.rpcName,
      chainId: network.chainId,
    });
    this.providers.set(network.name, provider);
    return provider;
  }

  public getContract(type: keyof typeof abis, networkName: string, address: string): ethers.Contract {
    if (!(type in abis)) throw new Error(`No ABI for ${type}`);
    const provider = this.getProviderForNetwork(networkName);
    this.signer = this.createSigner(provider);

    const nftContract: ethers.Contract = new ethers.Contract(address, abis[type], this.signer);
    return nftContract;
  }

  private createSigner(provider: ethers.Provider): ethers.HDNodeWallet | ethers.Wallet {
    const privateKey = this.config.getAuthoritySignerPrivateKey();
    if (privateKey) {
      return new ethers.Wallet(privateKey, provider);
    }

    const mnemonic = this.config.getAuthoritySignerMnemonic();
    if (mnemonic) {
      return ethers.Wallet.fromPhrase(mnemonic, provider);
    }

    return new ethers.Wallet(ethers.id('ownables-hub-fallback-key'), provider);
  }
}
