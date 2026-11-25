import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOkResponse, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { writeHttpError } from '../common/http/http-error-response';
import { EthersService } from '../common/ethers/ethers.service';
import { ConfigService, HubNetwork } from '../common/config/config.service';

@Controller(':network/hub')
@ApiTags('hub')
export class HubController {
  constructor(
    private readonly ethers: EthersService,
    private readonly config: ConfigService,
  ) {}

  @Get('wallet')
  @ApiProduces('application/json')
  @ApiParam({
    name: 'network',
    enum: ['base', 'base-sepolia'] satisfies HubNetwork[],
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['address', 'networkId', 'balance', 'unit'],
      properties: {
        address: { type: 'string' },
        networkId: { type: 'string', example: 'eip155:84532' },
        balance: { type: 'string' },
        unit: { type: 'string', example: 'ETH' },
      },
    },
  })
  async wallet(@Param('network') network: string, @Res() res: Response): Promise<Response> {
    try {
      return res.status(200).json(await this.ethers.getHubWallet(this.config.resolveHubNetwork(network)));
    } catch (error) {
      return writeHttpError(res, error);
    }
  }
}
