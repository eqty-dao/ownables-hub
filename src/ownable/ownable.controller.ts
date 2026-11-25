import { Controller, Get, Header, Param, Post, Req, Res, StreamableFile, UseFilters, UseInterceptors } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { OwnableService } from './ownable.service';
import { Signer } from '../common/http-signature/signer';
import { FileInterceptor } from '@nestjs/platform-express';
import { writeHttpError } from '../common/http/http-error-response';
import { MulterFileSizeFilter } from '../quarantine/multer-file-size.filter';
import { QuarantineUploadInterceptor } from '../quarantine/quarantine-upload.interceptor';
import { ConfigService, HubNetwork } from '../common/config/config.service';

const MAX_UPLOAD_BYTES = 268435456;
// Multer treats its fileSize limit as exclusive. The service below remains the
// authoritative inclusive 256 MiB boundary before any replay or staging work.
const MULTER_FILE_SIZE_LIMIT_BYTES = MAX_UPLOAD_BYTES + 1;

interface SignerIdentity {
  address?: string;
}

type FileUploadRequest = Request & { file?: Express.Multer.File };

@Controller(':network/ownables')
@ApiTags('ownables')
export class OwnableController {
  constructor(
    private ownableService: OwnableService,
    private readonly config: ConfigService,
  ) {}

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
  @UseFilters(MulterFileSizeFilter)
  @UseInterceptors(QuarantineUploadInterceptor, FileInterceptor('file', { limits: { fileSize: MULTER_FILE_SIZE_LIMIT_BYTES } }))
  @ApiParam({ name: 'network', enum: ['base', 'base-sepolia'] satisfies HubNetwork[] })
  async uploadOwnable(
    @Param('network') network: string,
    @Req() req: FileUploadRequest,
    @Res() res: Response,
    @Signer() signer?: SignerIdentity,
  ): Promise<Response> {
    const buffer = req.file?.buffer;
    if (!buffer || !Buffer.isBuffer(buffer)) {
      return res.status(400).send('Failed to read data from HTTP request');
    }

    try {
      const resolvedNetwork = this.config.resolveHubNetwork(network);
      const ownableInfo = await this.ownableService.uploadOwnable(buffer, resolvedNetwork, signer, true);
      const ownableId = String(ownableInfo.ownableId ?? '');
      if (ownableInfo.status === 'pending') {
        return res.status(202).json(ownableInfo);
      }
      if (ownableInfo.status === 'available') {
        if (ownableInfo.created) res.location(`/${resolvedNetwork.slug}/ownables/${encodeURIComponent(ownableId)}`);
        return res.status(ownableInfo.created ? 201 : 200).json(ownableInfo);
      }
      return res.location(`/${resolvedNetwork.slug}/ownables/${encodeURIComponent(ownableId)}`).status(201).json(ownableInfo);
    } catch (err) {
      return writeHttpError(res, err);
    }
  }

  @Get(':id/bundle')
  @ApiParam({ name: 'id' })
  @Header('Content-type', 'application/zip')
  @ApiProduces('application/zip')
  @ApiParam({ name: 'network', enum: ['base', 'base-sepolia'] satisfies HubNetwork[] })
  async download(@Param('network') network: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<StreamableFile | Response> {
    try {
      const id = String(req.params.id ?? '');
      return await this.ownableService.downloadOwnable(id, this.config.resolveHubNetwork(network));
    } catch (err) {
      return writeHttpError(res, err);
    }
  }

  @Get(':id/verification')
  @ApiParam({ name: 'id' })
  @ApiProduces('application/json')
  @ApiParam({ name: 'network', enum: ['base', 'base-sepolia'] satisfies HubNetwork[] })
  async verification(@Param('network') network: string, @Req() req: Request, @Res() res: Response): Promise<Response> {
    try {
      const id = String(req.params.id ?? '');
      const verification = await this.ownableService.getOwnableVerification(id, this.config.resolveHubNetwork(network));
      return res.status(200).json(verification);
    } catch (err) {
      return writeHttpError(res, err);
    }
  }

  @Get(':id/public-events')
  @ApiParam({ name: 'id' })
  @ApiProduces('application/json')
  @ApiParam({ name: 'network', enum: ['base', 'base-sepolia'] satisfies HubNetwork[] })
  async publicEvents(@Param('network') network: string, @Req() req: Request, @Res() res: Response): Promise<Response> {
    try {
      const id = String(req.params.id ?? '');
      const publicEvents = await this.ownableService.getOwnablePublicEvents(id, this.config.resolveHubNetwork(network));
      return res.status(200).json(publicEvents);
    } catch (err) {
      return writeHttpError(res, err);
    }
  }

}
