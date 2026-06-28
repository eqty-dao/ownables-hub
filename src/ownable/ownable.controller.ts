import { Controller, Get, Header, Query, Post, Req, Res, UseInterceptors, StreamableFile } from '@nestjs/common';
import { ApiBody, ApiProperty, ApiConsumes, ApiProduces } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { OwnableService } from './ownable.service';
import { Signer } from '../common/http-signature/signer';
import { AuthError, UserError } from '../interfaces/error';
import { FileInterceptor } from '@nestjs/platform-express';

interface SignerIdentity {
  address?: string;
}

@Controller('ownables')
export class OwnableController {
  constructor(private ownableService: OwnableService) {}

  @Post('/bridge')
  @ApiConsumes('multipart/form-data')
  @ApiProperty({ type: 'string', format: 'binary' })
  @ApiBody({
    description: 'Zipped Ownable package',
    required: true,
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async bridgeOwnable(@Req() req: Request, @Res() res: Response, @Signer() signer?: SignerIdentity): Promise<Response> {
    const buffer = req.file?.buffer;
    if (!buffer || Object.getPrototypeOf(buffer) === null || Object.prototype.isPrototypeOf(buffer) == false) {
      return res.status(400).send('Failed to read data from HTTP request');
    }

    try {
      const bridgedOwnableInfo = await this.ownableService.bridgeOwnable(buffer, signer, true);
      return res.status(201).json(bridgedOwnableInfo);
    } catch (err) {
      return this.errorResponse(res, err);
    }
  }

  @Get('claim')
  @Header('Content-type', 'application/zip')
  @ApiProduces('application/zip')
  async claim(
    @Query('cid') cid: string,
    @Res() res: Response,
    @Signer() signer?: SignerIdentity,
  ): Promise<StreamableFile | Response> {
    try {
      return await this.ownableService.claimOwnable(cid, signer);
    } catch (err) {
      return this.errorResponse(res, err);
    }
  }

  private errorResponse(res: Response, err: any) {
    if (err instanceof AuthError) return res.status(403).send(err.message);
    if (err instanceof UserError) return res.status(400).send(err.message);

    console.error(err);
    return res.status(500).send('Unexpected error');
  }

  @Get('proof')
  async getUnlockProof(@Query('cid') cid: string, @Signer() signer?: SignerIdentity) {
    try {
      const unlockProof = await this.ownableService.getUnlockProof(cid, signer);
      return { unlockProof };
    } catch (e) {
      return { error: `${e}` };
    }
  }

  @Get('isUnlockProofValid')
  async isUnlockProofValid(
    @Query('network') network: string,
    @Query('address') address: string,
    @Query('id') id: string,
    @Query('proof') proof: string,
  ) {
    try {
      const unlockProofvalid = await this.ownableService.isUnlockProofValid(network, address, id, proof);
      return { isUnlockProofValid: unlockProofvalid };
    } catch (e) {
      return { error: `${e}` };
    }
  }

  @Get('bridged')
  getBridgedOwnableCIDs(@Signer() signer?: SignerIdentity) {
    try {
      return { bridgedOwnables: `${this.ownableService.getBridgedOwnableCIDs(signer)}` };
    } catch (e) {
      return { error: `${e}` };
    }
  }

  @Get('chains')
  async GetAvailableNftChains() {
    try {
      return await this.ownableService.getAvailableNftChains();
    } catch (e) {
      return { error: `${e}` };
    }
  }

  @Get('cid')
  async getOwnableCidFromNFT(
    @Query('network') network: string,
    @Query('address') address: string,
    @Query('id') id: string,
  ) {
    try {
      return await this.ownableService.getOwnableCidFromNFT({ network, address, id });
    } catch (e) {
      return { error: `${e}` };
    }
  }

  @Get('serverinfo')
  async GetServerInfo() {
    try {
      const baseBalance = await this.ownableService.GetServerETHBalance('eip155:base');
      return {
        ServerBaseBalance: baseBalance,
      };
    } catch (e) {
      return { error: `${e}` };
    }
  }
}
