import { Controller, MessageEvent, Query, Sse } from '@nestjs/common';
import { ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { throwHttpError } from '../common/http/http-error-response';
import { OwnableService } from '../ownable/ownable.service';

@Controller('public-events')
@ApiTags('public-events')
export class PublicEventController {
  constructor(private readonly ownableService: OwnableService) {}

  @Sse()
  @ApiProduces('text/event-stream')
  @ApiQuery({ name: 'ownableId', required: true, type: String, isArray: true })
  @ApiQuery({ name: 'fromBlock', required: false, type: String, description: 'Decimal block number, default 0' })
  async stream(
    @Query('ownableId') ownableIds: string[] | string | undefined,
    @Query('fromBlock') fromBlock: string | string[] | undefined,
  ): Promise<Observable<MessageEvent>> {
    try {
      return await this.ownableService.streamOwnablePublicEvents(ownableIds, fromBlock);
    } catch (error) {
      return throwHttpError(error);
    }
  }
}
