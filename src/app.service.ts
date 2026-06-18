import { Injectable, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as process from 'process';
import { PostgresService } from './persistence/postgres.service.js';
import { ArchiveStorageService } from './storage/archive-storage.service.js';

type HealthDependency = 'database' | 'storage';

type HealthCheckStatus = 'ok' | 'error';

export interface AppHealth {
  status: HealthCheckStatus;
  checks: Record<HealthDependency, HealthCheckStatus>;
  errors?: Partial<Record<HealthDependency, string>>;
}

@Injectable()
export class AppService implements OnModuleInit {
  info: {
    name: string;
    version: string;
    description: string;
    env: string;
  };

  constructor(
    private readonly db: PostgresService,
    private readonly storage: ArchiveStorageService,
  ) {}

  onModuleInit(): void {
    const packageInfo = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

    this.info = {
      name: packageInfo.name,
      version: packageInfo.version,
      description: packageInfo.description,
      env: process.env['NODE_ENV'] || 'development',
    };
  }

  async getHealth(): Promise<AppHealth> {
    const checks: Array<{ dependency: HealthDependency; run: Promise<unknown> }> = [
      { dependency: 'database', run: this.db.query('SELECT 1') },
      { dependency: 'storage', run: this.storage.probe() },
    ];

    const results = await Promise.allSettled(checks.map(({ run }) => run));

    const response: AppHealth = {
      status: 'ok',
      checks: {
        database: 'ok',
        storage: 'ok',
      },
    };

    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        continue;
      }

      response.status = 'error';
      const dependency = checks[index]?.dependency ?? 'database';
      response.checks[dependency] = 'error';
      response.errors = {
        ...response.errors,
        [dependency]: this.stringifyError(result.reason),
      };
    }

    return response;
  }
  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
