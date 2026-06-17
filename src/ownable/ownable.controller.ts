import { Controller, Get, Header, Query, Post, Req, Res, UseGuards, UseInterceptors, StreamableFile } from '@nestjs/common';
import { ApiBody, ApiProperty, ApiConsumes, ApiProduces } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { OwnableService } from './ownable.service.js';
import { Signer } from '../common/http-signature/signer.js';
import { AuthError, UserError } from '../interfaces/error.js';
import { FileInterceptor } from '@nestjs/platform-express';
import { SIWEGuard } from '../common/siwe/siwe.guard.js';

interface SignerIdentity {
  address?: string;
}

type FileUploadRequest = Request & { file?: Express.Multer.File };

@Controller('ownables')
export class OwnableController {
  constructor(private ownableService: OwnableService) {}

  @Post('/upload')
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
  async uploadOwnable(@Req() req: FileUploadRequest, @Res() res: Response, @Signer() signer?: SignerIdentity): Promise<Response> {
    const buffer = req.file?.buffer;
    if (!buffer || !Buffer.isBuffer(buffer)) {
      return res.status(400).send('Failed to read data from HTTP request');
    }

    try {
      const bridgedOwnableInfo = await this.ownableService.uploadOwnable(buffer, signer, true);
      return res.status(201).json(bridgedOwnableInfo);
    } catch (err) {
      return this.errorResponse(res, err);
    }
  }

  @Post('/bridge')
  @ApiConsumes('multipart/form-data')
  @ApiProperty({ type: 'string', format: 'binary' })
  @ApiBody({
    description: 'Zipped Ownable package',
    required: true,
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @UseInterceptors(FileInterceptor('file'))
  async bridgeOwnable(@Req() req: FileUploadRequest, @Res() res: Response, @Signer() signer?: SignerIdentity): Promise<Response> {
    return this.uploadOwnable(req, res, signer);
  }

  @Get(':cid/download')
  @Header('Content-type', 'application/zip')
  @ApiProduces('application/zip')
  async download(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<StreamableFile | Response> {
    try {
      const cid = String(req.params.cid ?? '');
      return await this.ownableService.downloadOwnable(cid);
    } catch (err) {
      return this.errorResponse(res, err);
    }
  }

  @Get(':id/chain')
  @Header('Content-type', 'application/json')
  async chain(@Req() req: Request, @Res() res: Response): Promise<Response> {
    try {
      const id = String(req.params.id ?? '');
      const chain = await this.ownableService.downloadOwnableChain(id);
      return res.status(200).send(chain.toString('utf8'));
    } catch (err) {
      return this.errorResponse(res, err);
    }
  }

  @Get('claim')
  @Header('Content-type', 'application/zip')
  @ApiProduces('application/zip')
  async claim(@Query('cid') cid: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile | Response> {
    return this.download({ params: { cid } } as unknown as Request, res);
  }

  @Get(':cid/events')
  async events(@Req() req: Request, @Res() res: Response): Promise<Response> {
    try {
      const cid = String(req.params.cid ?? '');
      const events = await this.ownableService.getOwnableEvents(cid);
      return res.status(200).json({ cid, events });
    } catch (err) {
      return this.errorResponse(res, err);
    }
  }

  @Get('available')
  async available(@Query('owner') owner: string, @Res() res: Response): Promise<Response> {
    try {
      const availableOwnables = await this.ownableService.getAvailableOwnables(owner);
      return res.status(200).json(availableOwnables);
    } catch (err) {
      return this.errorResponse(res, err);
    }
  }

  private errorResponse(res: Response, err: any) {
    if (err instanceof AuthError) return res.status(403).json({ code: 'AUTH_ERROR', message: err.message });
    if (err instanceof UserError && err.message === 'RECIPIENT_DISCOVERY_DISABLED') return res.status(404).send('Not Found');
    if (err instanceof UserError && err.message.startsWith('STALE_OWNABLE')) {
      return res.status(409).json({ code: 'STALE_OWNABLE', message: err.message });
    }
    if (err instanceof UserError) return res.status(400).send(err.message);

    console.error(err);
    return res.status(500).send('Unexpected error');
  }

  @Get('proof')
  @UseGuards(SIWEGuard)
  async getUnlockProof(@Query('cid') cid: string, @Signer() signer?: SignerIdentity, @Res() res?: Response) {
    try {
      const unlockProof = await this.ownableService.getUnlockProof(cid, signer);
      if (res) return res.status(200).json({ unlockProof });
      return { unlockProof };
    } catch (e) {
      return this.errorResponse(res as Response, e);
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
  async getOwnableCidFromNFT(@Query('network') network: string, @Query('address') address: string, @Query('id') id: string) {
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
