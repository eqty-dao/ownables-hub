export interface NFTInfo {
  network: string;
  address: string;
  id: string;
}

export interface OwnableInfo {
  owner: string;
  issuer: string;
  nft: NFTInfo;
}
