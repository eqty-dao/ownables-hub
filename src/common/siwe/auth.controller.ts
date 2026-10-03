import { Body, Controller, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { SIWEMessage, SIWEService } from './siwe.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly siweService: SIWEService) {}

  @Post('nonce')
  @HttpCode(HttpStatus.OK)
  async getNonce(@Res() res: Response): Promise<Response> {
    return res.json({ nonce: this.siweService.generateNonce() });
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifySIWE(@Body() body: { message: SIWEMessage; signature: string }, @Res() res: Response): Promise<Response> {
    const result = await this.siweService.verifySIWEMessage(body.message, body.signature);
    if (!result.isValid) {
      return res.status(401).json({ error: result.error || 'SIWE verification failed' });
    }

    const token = Buffer.from(
      JSON.stringify({
        message: body.message,
        signature: body.signature,
      }),
    ).toString('base64');

    return res.json({
      success: true,
      address: result.address,
      token,
      expiresIn: '24h',
    });
  }
}
