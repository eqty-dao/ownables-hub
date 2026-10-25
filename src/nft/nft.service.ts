import { Injectable } from '@nestjs/common';
import { EthereumService } from './ethereum/ethereum.service';
import { NFTInfo } from '../interfaces/OwnableInfo';

@Injectable()
export class NFTService {
  constructor(private ethereum: EthereumService) { }

  public async isNFTlocked(nft: NFTInfo): Promise<boolean> {
    return await this.ethereum.isNFTlocked(nft);
  }

  public async getNFTcount(nft: NFTInfo): Promise<string> {
    return await this.ethereum.getNFTcount(nft);
  }

  public async isUnlockProofValid(proof: string, nft: NFTInfo): Promise<boolean> {
    return await this.ethereum.isUnlockProofValid(proof, nft);
  }
  
  async getUnlockProof(nft: NFTInfo): Promise<string> {
    if (nft.network.startsWith('eip155:')) {
      return await this.ethereum.getUnlockProof(nft);
    }

    throw new Error(`Unknown network ${nft.network}`);
  }
  public async getOwnerOfNFT(nft: NFTInfo): Promise<string> {
    return await this.ethereum.getOwnerOfNFT(nft);
  }
  async getIssuer(nft: NFTInfo): Promise<string> {
    if (nft.network.startsWith('eip155:')) {
      return await this.ethereum.getIssuer(nft);
    }

    throw new Error(`Unknown network ${nft.network}`);
  }

  public async GetServerETHBalance(networkName: string): Promise<string> {
    return await this.ethereum.GetServerETHBalance(networkName);
  }
  public verifyMessage(message: string, sig: string): string {
    return this.ethereum.verifyMessage(message, sig);
  }
  public async testSignMessage(message: string): Promise<string> {
    return await this.ethereum.testSignMessage(message);
  }
}
