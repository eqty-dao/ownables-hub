import { Controller, Get, Header, Post, Query, Req, Res, StreamableFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { OwnableService } from './ownable.service';
import { Signer } from '../common/http-signature/signer';
import { FileInterceptor } from '@nestjs/platform-express';
import { SIWEGuard } from '../common/siwe/siwe.guard';
import { writeHttpError } from '../common/http/http-error-response';

interface SignerIdentity {
  address?: string;
}

type FileUploadRequest = Request & { file?: Express.Multer.File };

@Controller('ownables')
@ApiTags('ownables')
export class OwnableController {
  constructor(private ownableService: OwnableService) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiProduces('application/json')
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
  @ApiCreatedResponse({ description: 'Ownable created', headers: { Location: { schema: { type: 'string' } } } })
  @UseInterceptors(FileInterceptor('file'))
  async uploadOwnable(@Req() req: FileUploadRequest, @Res() res: Response, @Signer() signer?: SignerIdentity): Promise<Response> {
    const buffer = req.file?.buffer;
    if (!buffer || !Buffer.isBuffer(buffer)) {
      return res.status(400).send('Failed to read data from HTTP request');
    }

    try {
      const ownableInfo = await this.ownableService.uploadOwnable(buffer, signer, true);
      const ownableId = String(ownableInfo.ownableId ?? '');
      return res.location(`/ownables/${encodeURIComponent(ownableId)}`).status(201).json(ownableInfo);
    } catch (err) {
      return writeHttpError(res, err);
    }
  }

  @Post('/bridge')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Zipped Ownable package',
    required: true,
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @UseInterceptors(FileInterceptor('file'))
  async bridgeOwnable(@Req() req: FileUploadRequest, @Res() res: Response, @Signer() signer?: SignerIdentity): Promise<Response> {
    return this.uploadOwnable(req, res, signer);
  }

  @Get(':id/bundle')
  @ApiParam({ name: 'id' })
  @Header('Content-type', 'application/zip')
  @ApiProduces('application/zip')
  async download(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<StreamableFile | Response> {
    try {
      const id = String(req.params.id ?? '');
      return await this.ownableService.downloadOwnable(id);
    } catch (err) {
      return writeHttpError(res, err);
    }
  }

  @Get(':id/verification')
  @ApiParam({ name: 'id' })
  @ApiProduces('application/json')
  async verification(@Req() req: Request, @Res() res: Response): Promise<Response> {
    try {
      const id = String(req.params.id ?? '');
      const verification = await this.ownableService.getOwnableVerification(id);
      return res.status(200).json(verification);
    } catch (err) {
      return writeHttpError(res, err);
    }
  }

  @Get(':id/public-events')
  @ApiParam({ name: 'id' })
  @ApiProduces('application/json')
  async publicEvents(@Req() req: Request, @Res() res: Response): Promise<Response> {
    try {
      const id = String(req.params.id ?? '');
      const publicEvents = await this.ownableService.getOwnablePublicEvents(id);
      return res.status(200).json(publicEvents);
    } catch (err) {
      return writeHttpError(res, err);
    }
  }

  @Get(':id/unlock-proof')
  @UseGuards(SIWEGuard)
  async getUnlockProof(@Req() req: Request, @Signer() signer?: SignerIdentity, @Res() res?: Response) {
    try {
      const id = String(req.params.id ?? '');
      const unlockProof = await this.ownableService.getUnlockProof(id, signer);
      if (res) return res.status(200).json({ unlockProof });
      return { unlockProof };
    } catch (e) {
      return writeHttpError(res as Response, e);
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

}
