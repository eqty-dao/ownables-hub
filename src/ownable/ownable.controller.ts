import { Controller, Get, Header, Post, Req, Res, StreamableFile, UseInterceptors } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { OwnableService } from './ownable.service';
import { Signer } from '../common/http-signature/signer';
import { FileInterceptor } from '@nestjs/platform-express';
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

}
