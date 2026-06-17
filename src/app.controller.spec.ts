import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppController } from './app.controller.js';
import { AppService, type AppHealth } from './app.service.js';

describe('AppController', () => {
  let app: INestApplication;
  const appService = {
    info: {
      name: '@ownables/hub',
      version: '0.0.0-test',
      description: 'test',
      env: 'test',
    },
    getHealth: jest.fn<Promise<AppHealth>, []>(),
  };

  beforeEach(async () => {
    appService.getHealth.mockReset();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: AppService, useValue: appService }],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns 200 for a healthy status', () => {
    appService.getHealth.mockResolvedValueOnce({
      status: 'ok',
      checks: {
        database: 'ok',
        storage: 'ok',
      },
    });

    return request(app.getHttpAdapter().getInstance())
      .get('/health')
      .expect(200)
      .expect({
        status: 'ok',
        checks: {
          database: 'ok',
          storage: 'ok',
        },
      });
  });

  it('returns 503 when a dependency is unhealthy', () => {
    appService.getHealth.mockResolvedValueOnce({
      status: 'error',
      checks: {
        database: 'error',
        storage: 'ok',
      },
      errors: {
        database: 'connection reset',
      },
    });

    return request(app.getHttpAdapter().getInstance())
      .get('/health')
      .expect(503)
      .expect({
        status: 'error',
        checks: {
          database: 'error',
          storage: 'ok',
        },
        errors: {
          database: 'connection reset',
        },
      });
  });
});
