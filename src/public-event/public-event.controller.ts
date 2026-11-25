import { Controller, MessageEvent, Param, Query, Sse } from '@nestjs/common';
import { ApiParam, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { throwHttpError } from '../common/http/http-error-response';
import { OwnableService } from '../ownable/ownable.service';
import { ConfigService, HubNetwork } from '../common/config/config.service';

@Controller(':network/streams/public-events')
@ApiTags('public-events')
export class PublicEventController {
  constructor(
    private readonly ownableService: OwnableService,
    private readonly config: ConfigService,
  ) {}

  @Sse()
  @ApiProduces('text/event-stream')
  @ApiParam({ name: 'network', enum: ['base', 'base-sepolia'] satisfies HubNetwork[] })
  @ApiQuery({ name: 'ownableId', required: true, type: String, isArray: true })
  @ApiQuery({ name: 'fromBlock', required: false, type: String, description: 'Decimal block number, default 0' })
  async stream(
    @Param('network') network: string,
    @Query('ownableId') ownableIds: string[] | string | undefined,
    @Query('fromBlock') fromBlock: string | string[] | undefined,
  ): Promise<Observable<MessageEvent>> {
    try {
      return await this.ownableService.streamOwnablePublicEvents(ownableIds, fromBlock, this.config.resolveHubNetwork(network));
    } catch (error) {
      return throwHttpError(error);
    }
  }
}
