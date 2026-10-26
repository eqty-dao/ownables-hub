import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { AppHealth, AppService } from './app.service';
import { ApiFoundResponse } from '@nestjs/swagger';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('/')
  @ApiFoundResponse({ description: 'Redirect to API documentation' })
  root(@Res() res: Response): void {
    res.redirect('/api-docs');
  }

  @Get('/info')
  getInfo(): {
    name: string;
    version: string;
    description: string;
    env: string;
  } {
    return this.appService.info;
  }

  @Get('/health')
  async getHealth(@Res({ passthrough: true }) res: Response): Promise<AppHealth> {
    const health = await this.appService.getHealth();
    if (health.status !== 'ok') {
      res.status(503);
    }
    return health;
  }
}
