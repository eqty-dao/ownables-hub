import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { SIWEMessage, SIWEService } from './siwe.service.js';

@Injectable()
export class SIWEAuthMiddleware implements NestMiddleware {
  constructor(private readonly siweService: SIWEService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      next();
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);
    let siweData: { message: SIWEMessage; signature: string };
    try {
      siweData = JSON.parse(Buffer.from(token, 'base64').toString());
    } catch {
      throw new UnauthorizedException('Invalid token format');
    }

    const result = await this.siweService.verifySIWEMessage(siweData.message, siweData.signature);
    if (!result.isValid) {
      throw new UnauthorizedException(result.error || 'SIWE verification failed');
    }

    req['user'] = {
      address: result.address,
      siweMessage: siweData.message,
    };
    req['signer'] = req['user'];

    next();
  }
}
