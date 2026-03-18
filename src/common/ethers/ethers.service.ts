import { Injectable, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService } from '../config/config.service';
import * as abis from './abi';
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
  private signer: ethers.HDNodeWallet;
  private alchemyProvider: ethers.AlchemyProvider;
  private network: ethers.Networkish;
  private readonly providers: Map<string | number, ethers.Provider> = new Map();

  constructor(private config: ConfigService) { }

  onModuleInit(): void {
    this.network = { name: 'base-sepolia', chainId: 84532 };
    this.alchemyProvider = new ethers.AlchemyProvider(
      this.network,
      this.config.get('eth.account.base_alchemy_api_key'),
    );
    this.signer = ethers.Wallet.fromPhrase(this.config.get('eth.account.mnemonic'), this.alchemyProvider);
  }

  public signMessage(message: string): Promise<string> {
    return this.signer.signMessage(ethers.toBeArray(message));
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
    const [alchemyNetworkNameMapped, chainId, providerApiKey] = this.getNetwork(networkName);
    this.network = { name: alchemyNetworkNameMapped, chainId: chainId };

    this.alchemyProvider = new ethers.AlchemyProvider(this.network, providerApiKey);
    // console.log("Blocknumber:", await this.alchemyProvider.getBlockNumber());
    return ethers.formatUnits(await this.alchemyProvider.getBalance(this.signer.address), 'ether').toString();
  }

  private getNetwork(networkName: string): [string, number, string] {
    // https://docs.ethers.org/v6/api/providers/thirdparty/#AlchemyProvider
    const networkId = this.config.get('lto.networkId');
    switch (networkName) {
      case 'eip155:ethereum':
        if (networkId === 'T')
          return ['sepolia', 11155111, this.config.get('eth.account.eth_alchemy_api_key')]; // Sepolia Testnet
        else return ['mainnet', 1, this.config.get('eth.account.eth_alchemy_api_key')]; // Ethereum Mainnet
      case 'eip155:arbitrum':
        if (networkId === 'T')
          // Arbitrum Sepolia Testnet
          return ['arbitrum-sepolia', 421614, this.config.get('eth.account.arbitrum_alchemy_api_key')];
        else return ['arbitrum', 42161, this.config.get('eth.account.arbitrum_alchemy_api_key')]; // Arbitrum Mainnet
      case 'eip155:polygon':
        if (networkId === 'T')
          return ['matic-amoy', 80002, this.config.get('eth.account.polygon_alchemy_api_key')]; // Polygon Amoy Testnet
        else return ['matic', 137, this.config.get('eth.account.polygon_alchemy_api_key')]; // Polygon mainnet
      case 'eip155:base':
        if (networkId === 'T')
          return ['base-sepolia', 84532, this.config.get('eth.account.base_alchemy_api_key')];
        else return ['base', 8453, this.config.get('eth.account.base_alchemy_api_key')];
    }
    throw new Error(
      `Incorrect network name. Supported network names: eip155:ethereum eip155:arbitrum eip155:polygon eip155:base`,
    );
  }

  public getContract(type: keyof typeof abis, networkName: string, address: string): ethers.Contract {
    if (!(type in abis)) throw new Error(`No ABI for ${type}`);
    const [alchemyNetworkNameMapped, chainId, providerApiKey] = this.getNetwork(networkName);
    this.network = { name: alchemyNetworkNameMapped, chainId: chainId };

    this.alchemyProvider = new ethers.AlchemyProvider(this.network, providerApiKey);

    this.signer = ethers.Wallet.fromPhrase(this.config.get('eth.account.mnemonic'), this.alchemyProvider);

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
