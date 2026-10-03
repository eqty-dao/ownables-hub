import { Test, TestingModule } from '@nestjs/testing';
import { CosmWasmService } from './cosmwasm.service';
import * as assert from 'assert';
import Contract from './contract';
import bs58 from 'bs58';

describe('CosmWasmService', () => {
  let service: CosmWasmService;
  let contract: Contract;
  let senderPublicKey: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CosmWasmService],
    }).compile();

    service = module.get<CosmWasmService>(CosmWasmService);
  });

  beforeAll(() => {
    senderPublicKey = bs58.encode(Buffer.alloc(32, 1));
  });

  beforeEach(async () => {
    contract = await service.load(__dirname + '/_test/ownable.js', __dirname + '/_test/ownable_bg.wasm');
  });

  describe('instantiate', () => {
    it('instantiates the smart contract', async () => {
      const result = await contract.instantiate(
        {
          ownable_id: '88pDRu52FpsU3kKHwdvPV21RMkBqVqNnthjfdCesTHQhLnUpanw49n6b2PzGnEy',
          package: 'bafybeie4ts4mbcw4pswzh45bj32ulcyztup2dr7zbbjv3y2ym3q3uuejba',
          network_id: 'T',
        },
        { sender: senderPublicKey, funds: [] },
      );
      assert.equal(result.attributes.method, 'instantiate');
      assert.equal(result.attributes.owner, senderPublicKey);
      assert.equal(result.attributes.current_amount, '100');
    });

    it('instantiates the smart contract with NFT information', async () => {
      await contract.instantiate(
        {
          ownable_id: '88pDRu52FpsU3kKHwdvPV21RMkBqVqNnthjfdCesTHQhLnUpanw49n6b2PzGnEy',
          package: 'bafybeie4ts4mbcw4pswzh45bj32ulcyztup2dr7zbbjv3y2ym3q3uuejba',
          network_id: 'T',
          nft: {
            network: 'eip155:84532',
            address: '0x6ebeaf8e8e946f0716e6533a6f2cefc83f60e8ab',
            id: '1',
          },
        },
        { sender: senderPublicKey, funds: [] },
      );
    });
  });

  describe('query', () => {
    let color: string;

    beforeEach(async () => {
      const result = await contract.instantiate(
        {
          ownable_id: '88pDRu52FpsU3kKHwdvPV21RMkBqVqNnthjfdCesTHQhLnUpanw49n6b2PzGnEy',
          package: 'bafybeie4ts4mbcw4pswzh45bj32ulcyztup2dr7zbbjv3y2ym3q3uuejba',
          network_id: 'T',
          nft: {
            network: 'eip155:84532',
            address: '0x6ebeaf8e8e946f0716e6533a6f2cefc83f60e8ab',
            id: '1',
          },
        },
        { sender: senderPublicKey, funds: [] },
      );

      color = result.attributes.color;
    });

    it('can query the widget state', async () => {
      const state = await contract.query({ get_widget_state: {} });
      assert.equal(state.current_amount, '100');
      assert.equal(state.color, color);
    });

    it('can query the info', async () => {
      const info = await contract.query({ get_info: {} });
      assert.equal(typeof info.owner, 'string');
      assert.equal(info.owner.startsWith('3'), true);
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      await contract.instantiate(
        {
          ownable_id: '88pDRu52FpsU3kKHwdvPV21RMkBqVqNnthjfdCesTHQhLnUpanw49n6b2PzGnEy',
          package: 'bafybeie4ts4mbcw4pswzh45bj32ulcyztup2dr7zbbjv3y2ym3q3uuejba',
          network_id: 'T',
        },
        { sender: senderPublicKey, funds: [] },
      );
    });

    it('executes a message on the smart contract', async () => {
      const result = await contract.execute({ drink: { amount: 42 } }, { sender: senderPublicKey, funds: [] });
      assert.equal(result.attributes.method, 'try_drink');
      assert.equal(result.attributes.new_amount, 58);

      const state = await contract.query({ get_widget_state: {} });
      assert.equal(state.current_amount, 58);
    });
  });
});
