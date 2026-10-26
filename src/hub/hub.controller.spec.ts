import { HubController } from './hub.controller';
import { UserError } from '../interfaces/error';

describe('HubController', () => {
  const buildResponse = () => {
    const response: any = {};
    response.status = jest.fn(() => response);
    response.json = jest.fn(() => response);
    response.send = jest.fn(() => response);
    return response;
  };

  it('returns only the public wallet response fields', async () => {
    const ethers = {
      getHubWallet: jest.fn().mockResolvedValue({
        address: '0x0000000000000000000000000000000000000001',
        networkId: 'eip155:84532',
        balance: '1.25',
        unit: 'ETH',
      }),
    } as any;
    const response = buildResponse();

    await new HubController(ethers).wallet('eip155:base', response);

    expect(ethers.getHubWallet).toHaveBeenCalledWith('eip155:base');
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      address: '0x0000000000000000000000000000000000000001',
      networkId: 'eip155:84532',
      balance: '1.25',
      unit: 'ETH',
    });
  });

  it('maps unsupported networks to 400 and provider errors to 500', async () => {
    const unsupported = { getHubWallet: jest.fn().mockRejectedValue(new UserError('Incorrect network name')) } as any;
    const unsupportedResponse = buildResponse();
    await new HubController(unsupported).wallet('eip155:unknown', unsupportedResponse);
    expect(unsupportedResponse.status).toHaveBeenCalledWith(400);

    const unavailable = { getHubWallet: jest.fn().mockRejectedValue(new Error('provider unavailable')) } as any;
    const unavailableResponse = buildResponse();
    await new HubController(unavailable).wallet('eip155:base', unavailableResponse);
    expect(unavailableResponse.status).toHaveBeenCalledWith(500);
  });
});
