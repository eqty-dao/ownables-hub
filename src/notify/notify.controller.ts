import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { NotifyService } from './notify.service.js';

@Controller('notify')
export class NotifyController {
  constructor(private readonly notifyService: NotifyService) {}

  @Get('delivery-status')
  async getDeliveryStatus(@Query('cid') cid: string, @Query('owner') owner: string) {
    const row = await this.notifyService.getDeliveryStatus(cid, owner);
    if (!row) {
      throw new NotFoundException(`No notify delivery state found for cid ${cid} and owner ${owner}`);
    }

    return {
      cid: row.cid,
      owner: row.ownerAccount,
      ownerStateVersion: row.ownerStateVersion,
      triggerKind: row.triggerKind,
      status: row.status,
      notificationId: row.notificationId,
      transportId: row.transportId,
      lastAttemptAt: row.lastAttemptAt,
      deliveredAt: row.deliveredAt,
      errorCode: row.errorCode,
      message: row.message,
    };
  }

  @Get('local/discovery')
  async getLocalDiscovery(@Query('owner') owner: string) {
    return this.notifyService.getLocalDiscoveryEntries(owner);
  }
}
