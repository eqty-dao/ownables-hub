export default {
  account: {
    seed: 'candy maple cake sugar pudding cream honey rich smooth crumble sweet treat',
  },
  lto: {
    node: 'https://testnet.lto.network',
    networkId: 'T',
    account: {
      seed: 'test1 test2 test3 test4 test5 test6 test7 test8 test9 test10 test11 test12',
    },
  },
  eth: {
    account: {
      mnemonic: 'sell globe farm embody menu tennis cruise hero crawl universe stock enrich',
      arbitrum_alchemy_api_key: 'dN8Sr0rKWmfbfV2GsKpFbl98_QkeiR6j',
      polygon_alchemy_api_key: '7BXCsiKVO6RNJ7cPllx17hQHTa-nEx_I',
      eth_alchemy_api_key: 'oI9B3F4SsW2kFEuEKwfIgn_Wxz5NoEz9',
      base_alchemy_api_key: '',
    },
    contracts: {
      ethereum: '0x0eb02E5382944EA6Bf3B79D3253b68289b5d7078', // Ethereum sepolia
      arbitrum: '0x7FE0d2D2665F3581bcb24eeC1c88283e6371af33', // Arbitrum sepolia
      polygon: '', // Polygon Mumbai
      base: '',
      base_sepolia: '',
    },
  },
  ipfs: {
    start: false,
  },
};
