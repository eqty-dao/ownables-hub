import { Controller, Get, MessageEvent, Param, Res, Sse } from '@nestjs/common';
import { ApiOkResponse, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { throwHttpError, writeHttpError } from '../common/http/http-error-response';
import { OwnableService } from '../ownable/ownable.service';
import { ConfigService, HubNetwork } from '../common/config/config.service';

@Controller(':network')
@ApiTags('accounts')
export class AccountController {
  constructor(
    private readonly ownableService: OwnableService,
    private readonly config: ConfigService,
  ) {}

  @Get('inbox/:address')
  @ApiParam({ name: 'network', enum: ['base', 'base-sepolia'] satisfies HubNetwork[] })
  @ApiParam({ name: 'address', description: 'EVM address' })
  @ApiProduces('application/json')
  @ApiOkResponse({ description: 'Ownables available to the account' })
  async available(@Param('network') network: string, @Param('address') address: string, @Res() res: Response): Promise<Response> {
    try {
      return res.status(200).json(await this.ownableService.getAvailableOwnables(address, this.config.resolveHubNetwork(network)));
    } catch (error) {
      return writeHttpError(res, error);
    }
  }

  @Sse('streams/inbox/:address')
  @ApiParam({ name: 'network', enum: ['base', 'base-sepolia'] satisfies HubNetwork[] })
  @ApiParam({ name: 'address', description: 'EVM address' })
  @ApiProduces('text/event-stream')
  availableEvents(@Param('network') network: string, @Param('address') address: string): Observable<MessageEvent> {
    try {
      return this.ownableService.streamAvailableOwnables(address, this.config.resolveHubNetwork(network));
    } catch (error) {
      return throwHttpError(error);
    }
  }
}
