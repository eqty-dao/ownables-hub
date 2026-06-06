import { Controller, Get, Module, Post } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from './common/config/config.module.js';
import { configureApp } from './app.bootstrap.js';

@Controller()
class CorsTestController {
  @Get('/info')
  info() {
    return { ok: true };
  }

  @Post('/ownables/upload')
  upload() {
    return { ok: true };
  }
}

@Module({
  imports: [ConfigModule],
  controllers: [CorsTestController],
})
class CorsTestModule {}

describe('configureApp', () => {
  let app: INestApplication;
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgres://planner:planner@127.0.0.1:5432/ownables_hub_test';
    process.env.TESTNET_CHAIN_ID = '84532';
    process.env.TESTNET_RPC_URL = 'https://testnet-rpc';
    process.env.TESTNET_ANCHOR_CONTRACT_ADDR = '0x1111111111111111111111111111111111111111';
    process.env.TESTNET_ANCHOR_START_BLOCK = '100';
    process.env.MAINNET_CHAIN_ID = '8453';
    process.env.MAINNET_RPC_URL = 'https://mainnet-rpc';
    process.env.MAINNET_ANCHOR_CONTRACT_ADDR = '0x2222222222222222222222222222222222222222';
    process.env.MAINNET_ANCHOR_START_BLOCK = '200';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CorsTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    process.env = originalEnv;
  });

  it('returns CORS headers for the SDK dev origin on /info', () => {
    return request(app.getHttpAdapter().getInstance())
      .get('/info')
      .set('Origin', 'http://127.0.0.1:5173')
      .expect(200)
      .expect('access-control-allow-origin', 'http://127.0.0.1:5173');
  });

  it('answers upload preflight for the SDK dev origin', () => {
    return request(app.getHttpAdapter().getInstance())
      .options('/ownables/upload')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204)
      .expect('access-control-allow-origin', 'http://127.0.0.1:5173')
      .expect('access-control-allow-methods', /POST/)
      .expect('vary', /Origin/);
  });
});
