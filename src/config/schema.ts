export default {
  env: {
    format: ['production', 'staging', 'development', 'test'],
    default: 'development',
    env: 'NODE_ENV',
  },
  port: {
    default: 80,
    env: 'PORT',
  },
  account: {
    seed: {
      default: '',
      env: 'ACCOUNT_SEED',
    },
  },
  accept: {
    unlockNFT: {
      default: true,
      env: 'UNLOCK_NFT',
    },
    webhook: {
      default: '',
      env: 'ACCEPT_WEBHOOK',
    },
  },
  auth: {
    disable: {
      default: false,
      env: 'AUTH_DISABLE',
    },
  },
  siwe: {
    domain: {
      default: 'localhost',
      env: 'SIWE_DOMAIN',
    },
  },
  lto: {
    node: {
      default: 'https://testnet.lto.network',
      env: 'LTO_NODE',
    },
    networkId: {
      default: 'T',
      env: 'LTO_NETWORK_ID',
    },
    account: {
      seed: {
        default: '',
        env: 'LTO_ACCOUNT_SEED',
      },
    },
  },
  eth: {
    account: {
      mnemonic: {
        default: '',
        env: 'ACCOUNT_MNEMONIC',
      },
      arbitrum_alchemy_api_key: {
        default: '',
        env: 'ARBITRUM_ALCHEMY_API_KEY',
      },
      polygon_alchemy_api_key: {
        default: '',
        env: 'POLYGON_ALCHEMY_API_KEY',
      },
      eth_alchemy_api_key: {
        default: '',
        env: 'ETH_ALCHEMY_API_KEY',
      },
      base_alchemy_api_key: {
        default: '',
        env: 'BASE_ALCHEMY_API_KEY',
      },
    },
    contracts: {
      ethereum: {
        default: '',
        env: 'ETHEREUM_NFT_CONTRACT_ADDR',
      },
      arbitrum: {
        default: '',
        env: 'ARBITRUM_NFT_CONTRACT_ADDR',
      },
      polygon: {
        default: '',
        env: 'POLYGON_NFT_CONTRACT_ADDR',
      },
      base: {
        default: '',
        env: 'BASE_NFT_CONTRACT_ADDR',
      },
      base_sepolia: {
        default: '',
        env: 'BASE_SEPOLIA_NFT_CONTRACT_ADDR',
      },
    },
    providers: {
      etherscan: {
        default: '',
        env: 'ETHERSCAN_KEY',
      },
      infura: {
        default: '',
        env: 'INFURA_KEY',
      },
      alchemy: {
        default: '',
        env: 'ALCHEMY_KEY',
      },
      pocket: {
        default: '',
        env: 'POCKET_KEY',
      },
      ankr: {
        default: '',
        env: 'ANKR_KEY',
      },
    },
    networks: {
      default: [
        {
          id: 84532,
          name: 'baseSepolia',
          provider: 'jsonrpc' as 'jsonrpc' | 'etherscan' | 'infura' | 'alchemy' | 'cloudflare' | 'pocket' | 'ankr',
          url: '',
        },
      ],
      // default: [
      //   {
      //     id: 80001,
      //     name: 'PolygonMumbai',
      //     provider: 'alchemy' as 'jsonrpc' | 'etherscan' | 'infura' | 'alchemy' | 'cloudflare' | 'pocket' | 'ankr',
      //     url: `https://polygon-mumbai.g.alchemy.com/v2/${process.env.POLYGON_MUMBAI_ALCHEMY_API_KEY}`,
      //   },
      // ],
      format: 'typed-array',
      children: {
        id: {
          default: 0,
        },
        name: {
          default: '',
        },
        provider: {
          format: ['jsonrpc', 'etherscan', 'infura', 'alchemy', 'cloudflare', 'pocket', 'ankr'],
          default: 'jsonrpc',
        },
        url: {
          default: '',
        },
      },
    },
  },
  log: {
    level: {
      default: '',
      env: 'LOG_LEVEL',
    },
  },
  ssl: {
    enabled: {
      default: false,
      env: 'SSL_ENABLED',
    },
  },
  ipfs: {
    start: {
      default: true,
      env: 'IPFS_START',
    },
  },
  path: {
    packages: {
      default: 'storage/packages',
      env: 'PACKAGES_PATH',
    },
    chains: {
      default: 'storage/chains',
      env: 'CHAINS_PATH',
    },
    users: {
      default: 'storage/users',
      env: 'USERS_PATH',
    },
    nfts: {
      default: 'storage/nfts',
      env: 'NFTS_PATH',
    },
  },
  verify: {
    integrity: {
      default: true,
      env: 'VERIFY_INTEGRITY',
    },
    signer: {
      default: true,
      env: 'VERIFY_SIGNER',
    },
    chainId: {
      default: true,
      env: 'VERIFY_CHAIN_ID',
    },
  },
};
