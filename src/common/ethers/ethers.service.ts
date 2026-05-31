import { Injectable, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService, RuntimeNetworkProfile } from '../config/config.service.js';
import * as abis from './abi/index.js';
// import { throwError } from 'rxjs';
// import { Networkish } from '@ethersproject/networks';

// type NetworkSettings = {
//   id: number;
//   name: string;
//   provider: 'jsonrpc' | 'etherscan' | 'infura' | 'alchemy' | 'cloudflare' | 'pocket' | 'ankr';
//   url?: string;
// };

@Injectable()
export class EthersService implements OnModuleInit {
  private wallet: ethers.Wallet;
  private signer: ethers.HDNodeWallet | ethers.Wallet;
  private networkProfile: RuntimeNetworkProfile;
  private readonly providers: Map<string | number, ethers.Provider> = new Map();

  constructor(private config: ConfigService) { }

  onModuleInit(): void {
    this.networkProfile = this.config.getRuntimeNetworkProfile();
    const mnemonic = this.config.getAuthoritySignerMnemonic();
    const provider = this.getProviderForNetwork('eip155:base');
    this.signer = mnemonic
      ? ethers.Wallet.fromPhrase(mnemonic, provider)
      : new ethers.Wallet(ethers.id('ownables-hub-fallback-key'), provider);
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

  private getNetwork(networkName: string): [string, number, string] {
    const profile = this.networkProfile;
    switch (networkName) {
      case 'eip155:ethereum':
        if (profile === 'testnet')
          return ['sepolia', 11155111, this.config.getRpcUrl('testnet', 'eip155:ethereum')];
        return ['mainnet', 1, this.config.getRpcUrl('mainnet', 'eip155:ethereum')];
      case 'eip155:arbitrum':
        if (profile === 'testnet')
          return ['arbitrum-sepolia', 421614, this.config.getRpcUrl('testnet', 'eip155:arbitrum')];
        return ['arbitrum', 42161, this.config.getRpcUrl('mainnet', 'eip155:arbitrum')];
      case 'eip155:polygon':
        if (profile === 'testnet')
          return ['matic-amoy', 80002, this.config.getRpcUrl('testnet', 'eip155:polygon')];
        return ['matic', 137, this.config.getRpcUrl('mainnet', 'eip155:polygon')];
      case 'eip155:base':
        if (profile === 'testnet')
          return ['base-sepolia', 84532, this.config.getRpcUrl('testnet', 'eip155:base')];
        return ['base', 8453, this.config.getRpcUrl('mainnet', 'eip155:base')];
    }
    throw new Error(
      `Incorrect network name. Supported network names: eip155:ethereum eip155:arbitrum eip155:polygon eip155:base`,
    );
  }

  private getProviderForNetwork(networkName: string): ethers.JsonRpcProvider {
    const [networkMappedName, chainId, rpcUrl] = this.getNetwork(networkName);
    return new ethers.JsonRpcProvider(rpcUrl, { name: networkMappedName, chainId });
  }

  public getContract(type: keyof typeof abis, networkName: string, address: string): ethers.Contract {
    if (!(type in abis)) throw new Error(`No ABI for ${type}`);
    const provider = this.getProviderForNetwork(networkName);
    const mnemonic = this.config.getAuthoritySignerMnemonic();
    this.signer = mnemonic
      ? ethers.Wallet.fromPhrase(mnemonic, provider)
      : new ethers.Wallet(ethers.id('ownables-hub-fallback-key'), provider);

    const nftContract: ethers.Contract = new ethers.Contract(address, abis[type], this.signer);
    return nftContract;
  }

  // private initProviders() {
  //   const networks = this.config.get('eth.networks');
  //   const providerKeys = this.config.get('eth.providers');

  //   for (const network of networks) {
  //     const provider = this.createProvider(network, providerKeys);
  //     this.providers.set(network.id, provider);
  //     this.providers.set(network.name, provider);
  //   }
  // }

  // private createProvider(network: NetworkSettings, providerKeys: { [_: string]: string }): ethers.providers.Provider {
  //   switch (network.provider) {
  //     case 'jsonrpc':
  //       return new ethers.providers.JsonRpcProvider(network.url, {
  //         name: network.name,
  //         chainId: network.id,
  //       });
  //     case 'etherscan':
  //       return new ethers.providers.EtherscanProvider(network.id, providerKeys.etherscan);
  //     case 'infura':
  //       return new ethers.providers.InfuraProvider(network.id, providerKeys.infura);
  //     case 'alchemy':
  //       return new ethers.providers.AlchemyProvider(network.id, providerKeys.alchemy);
  //     case 'cloudflare':
  //       return new ethers.providers.CloudflareProvider(network.id, providerKeys.cloudflare);
  //     case 'pocket':
  //       return new ethers.providers.PocketProvider(network.id, providerKeys.pocket);
  //     case 'ankr':
  //       return new ethers.providers.AnkrProvider(network.id, providerKeys.ankr);
  //   }
  // }

  // public getContract(type: keyof typeof abis, network: Networkish, address: string): ethers.Contract {
  //   if (!(type in abis)) throw new Error(`No ABI for ${type}`);

  //   const networkId = typeof network === 'object' ? network.chainId : network;
  //   const provider = this.providers.get(networkId);
  //   if (!provider) throw new Error(`No provider for network ${networkId}`);

  //   return new ethers.Contract(address, abis[type], provider);
  // }
}
