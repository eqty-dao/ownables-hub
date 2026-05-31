import { Injectable, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as process from 'process';

@Injectable()
export class AppService implements OnModuleInit {
  info: {
    name: string;
    version: string;
    description: string;
    env: string;
  };

  onModuleInit(): void {
    const packageInfo = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

    this.info = {
      name: packageInfo.name,
      version: packageInfo.version,
      description: packageInfo.description,
      env: process.env['NODE_ENV'] || 'development',
    };
  }
}
