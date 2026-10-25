import { Injectable } from '@nestjs/common';
import { EthersService } from '../../common/ethers/ethers.service';
import { NFTInfo } from '../../interfaces/OwnableInfo';

@Injectable()
export class EthereumService {
  constructor(private ethers: EthersService) { }

  public async isNFTlocked(nft: NFTInfo): Promise<boolean> {
    const nftContract = this.ethers.getContract('LockableNFT', nft.network, nft.address);
    return await nftContract.isLocked(nft.id);
  }

  public async getNFTcount(nft: NFTInfo): Promise<string> {
    const nftContract = this.ethers.getContract('LockableNFT', nft.network, nft.address);
    return (await nftContract.getNftCount()).toString();
  }

  public async isUnlockProofValid(proof: string, nft: NFTInfo): Promise<boolean> {
    const nftContract = this.ethers.getContract('LockableNFT', nft.network, nft.address);
    return await nftContract.isUnlockProofValid(nft.id, proof);
  }

  public async getUnlockProof(nft: NFTInfo): Promise<string> {
    const nftContract = this.ethers.getContract('LockableNFT', nft.network, nft.address);
    const challenge = await nftContract.unlockChallenge(nft.id);

    return await this.ethers.signMessage(challenge.toString());
  }

  public async getOwnerOfNFT(nft: NFTInfo): Promise<string> {
    const nftContract = this.ethers.getContract('LockableNFT', nft.network, nft.address);
    return await nftContract.ownerOf(nft.id);
  }
  public async getIssuer(nft: NFTInfo): Promise<string> {
    const nftContract = this.ethers.getContract('LockableNFT', nft.network, nft.address);
    return await nftContract.owner();
  }
  public async GetServerETHBalance(networkName: string): Promise<string> {
    return await this.ethers.GetServerETHBalance(networkName);
  }

  public verifyMessage(message: string, sig: string): string {
    return this.ethers.verifyMessage(message, sig);
  }
  public async testSignMessage(message: string): Promise<string> {
    return await this.ethers.testSignMessage(message);
  }
}
