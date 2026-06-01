import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Signer } from '../common/http-signature/signer.js';
import { SIWEGuard } from '../common/siwe/siwe.guard.js';
import { NotifyService } from './notify.service.js';

interface SignerIdentity {
  address?: string;
}

interface RegisterNotifyBody {
  ownerAddress: string;
  topic: string;
  previousTopic?: string;
  ownerAccount?: string;
}

@Controller('notify')
export class NotifyController {
  constructor(private readonly notifyService: NotifyService) {}

  @Post('registrations')
  @UseGuards(SIWEGuard)
  async register(@Body() body: RegisterNotifyBody, @Signer() signer?: SignerIdentity) {
    return this.notifyService.register({
      ownerAddress: body.ownerAddress,
      topic: body.topic,
      previousTopic: body.previousTopic,
      ownerAccount: body.ownerAccount,
      signerAddress: signer?.address || '',
    });
  }
}
