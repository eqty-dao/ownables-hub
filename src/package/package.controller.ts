import { Controller, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import { ApiProperty, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { PackageService } from './package.service.js';
import { FileInterceptor } from '@nestjs/platform-express';

type FileUploadRequest = Request & { file?: Express.Multer.File };

@Controller('packages')
@ApiTags('packages')
export class PackageController {
  constructor(private readonly packageService: PackageService) {}

  @Post('/')
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
  async root(@Req() req: FileUploadRequest, @Res() res: Response): Promise<Response> {
    const buffer = req.file?.buffer;
    if (!buffer || Object.getPrototypeOf(buffer) === null || Object.prototype.isPrototypeOf(buffer) == false) {
      return res.status(400).send('Failed to read data from HTTP request');
    }
    const cid = await this.packageService.store(buffer);

    return res.status(201).json({ cid });
  }
}
