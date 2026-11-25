import { HubController } from './hub.controller';
import { UserError } from '../interfaces/error';

describe('HubController', () => {
  const baseSepolia = {
    slug: 'base-sepolia',
    caip2: 'eip155:84532',
    chainId: '84532',
    slotName: 'testnet',
    rpcUrl: 'https://base-sepolia.example.test',
  } as const;

  const buildResponse = () => {
    const response: any = {};
    response.status = jest.fn(() => response);
    response.json = jest.fn(() => response);
    response.send = jest.fn(() => response);
    return response;
  };

  it('returns only the public wallet response fields for the URL network', async () => {
    const ethers = {
      getHubWallet: jest.fn().mockResolvedValue({
        address: '0x0000000000000000000000000000000000000001',
        networkId: 'eip155:84532',
        balance: '1.25',
        unit: 'ETH',
      }),
    } as any;
    const config = { resolveHubNetwork: jest.fn(() => baseSepolia) } as any;
    const response = buildResponse();

    await new HubController(ethers, config).wallet('base-sepolia', response);

    expect(config.resolveHubNetwork).toHaveBeenCalledWith('base-sepolia');
    expect(ethers.getHubWallet).toHaveBeenCalledWith(baseSepolia);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      address: '0x0000000000000000000000000000000000000001',
      networkId: 'eip155:84532',
      balance: '1.25',
      unit: 'ETH',
    });
  });

  it('maps unsupported networks to 400 and provider errors to 500', async () => {
    const unsupportedConfig = { resolveHubNetwork: jest.fn(() => { throw new UserError('Unsupported Hub network'); }) } as any;
    const unsupportedResponse = buildResponse();
    await new HubController({ getHubWallet: jest.fn() } as any, unsupportedConfig).wallet('ethereum', unsupportedResponse);
    expect(unsupportedResponse.status).toHaveBeenCalledWith(400);

    const unavailable = { getHubWallet: jest.fn().mockRejectedValue(new Error('provider unavailable')) } as any;
    const unavailableResponse = buildResponse();
    await new HubController(unavailable, { resolveHubNetwork: jest.fn(() => baseSepolia) } as any).wallet('base-sepolia', unavailableResponse);
    expect(unavailableResponse.status).toHaveBeenCalledWith(500);
  });
});
