import { Controller, Get, MessageEvent, Param, Res, Sse } from '@nestjs/common';
import { ApiOkResponse, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { throwHttpError, writeHttpError } from '../common/http/http-error-response';
import { OwnableService } from '../ownable/ownable.service';

@Controller('accounts')
@ApiTags('accounts')
export class AccountController {
  constructor(private readonly ownableService: OwnableService) {}

  @Get(':account/available-ownables')
  @ApiParam({ name: 'account', description: 'CAIP-10 account' })
  @ApiProduces('application/json')
  @ApiOkResponse({ description: 'Ownables available to the account' })
  async available(@Param('account') account: string, @Res() res: Response): Promise<Response> {
    try {
      return res.status(200).json(await this.ownableService.getAvailableOwnables(account));
    } catch (error) {
      return writeHttpError(res, error);
    }
  }

  @Sse(':account/available-ownables/events')
  @ApiParam({ name: 'account', description: 'CAIP-10 account' })
  @ApiProduces('text/event-stream')
  availableEvents(@Param('account') account: string): Observable<MessageEvent> {
    try {
      return this.ownableService.streamAvailableOwnables(account);
    } catch (error) {
      return throwHttpError(error);
    }
  }
}
