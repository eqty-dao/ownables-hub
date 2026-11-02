import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { MulterError } from 'multer';

@Catch(MulterError)
export class MulterFileSizeFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'LIMIT_FILE_SIZE') {
      response.status(413).json({ code: 'UPLOAD_TOO_LARGE', message: 'Upload exceeds the 268435456 byte limit' });
      return;
    }
    response.status(400).json({ code: 'UPLOAD_INVALID', message: 'Failed to read upload data' });
  }
}
