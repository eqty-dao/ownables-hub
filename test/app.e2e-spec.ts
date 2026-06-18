import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';

@Controller()
class DownloadFixtureController {
  @Get('/info')
  info() {
    return { ok: true };
  }
}

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    process.env.SIGNER_MNEMONIC = 'test test test test test test test test test test test junk';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('/info (GET)', () => {
    return request(app.getHttpAdapter().getInstance())
      .get('/info')
      .expect(200)
      .expect(({ body }) => {
        expect(body.name).toBe('@ownables/hub');
        expect(body.env).toBeDefined();
      });
  });
});
