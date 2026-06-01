import { BadRequestException } from '@nestjs/common';
import { NotifyController } from './notify.controller.js';

describe('NotifyController', () => {
  it('returns registration result', async () => {
    const notifyService = { register: jest.fn().mockResolvedValue({ status: 'created', catchUpAttempted: 1 }) };
    const controller = new NotifyController(notifyService as any);

    const result = await controller.register({ ownerAddress: '0xabc', topic: 'topic-a' }, { address: '0xabc' });

    expect(notifyService.register).toHaveBeenCalledWith({
      ownerAddress: '0xabc',
      topic: 'topic-a',
      previousTopic: undefined,
      ownerAccount: undefined,
      signerAddress: '0xabc',
    });
    expect(result).toEqual({ status: 'created', catchUpAttempted: 1 });
  });

  it('surfaces signer mismatch rejection', async () => {
    const notifyService = { register: jest.fn().mockRejectedValue(new BadRequestException('Signer and ownerAddress mismatch')) };
    const controller = new NotifyController(notifyService as any);

    await expect(controller.register({ ownerAddress: '0xabc', topic: 'topic-a' }, { address: '0xdef' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
