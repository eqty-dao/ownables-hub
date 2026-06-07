import { Controller, Get, INestApplication, Module, StreamableFile } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import JSZip from 'jszip';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { OwnableController } from './../src/ownable/ownable.controller.js';
import { OwnableService } from './../src/ownable/ownable.service.js';

@Controller()
class DownloadFixtureController {
  @Get('/info')
  info() {
    return { ok: true };
  }
}

@Module({
  controllers: [OwnableController, DownloadFixtureController],
  providers: [
    {
      provide: OwnableService,
      useValue: {
        downloadOwnable: jest.fn(),
      },
    },
  ],
})
class DownloadFixtureModule {}

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    process.env.ACCOUNT_MNEMONIC = 'test test test test test test test test test test test junk';

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

describe('Ownable download route (e2e)', () => {
  let app: INestApplication;
  let ownableService: { downloadOwnable: jest.Mock };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [DownloadFixtureModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    ownableService = moduleFixture.get(OwnableService);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('streams a non-empty zip body for GET /ownables/:cid/download', async () => {
    const zip = new JSZip();
    zip.file('chain.json', JSON.stringify({ cid: 'cid-1' }));
    const zipBuffer = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
    ownableService.downloadOwnable.mockResolvedValue(new StreamableFile(zipBuffer));

    const response = await request(app.getHttpServer()).get('/ownables/cid-1/download').expect(200).expect('Content-Type', /application\/zip/);

    expect(ownableService.downloadOwnable).toHaveBeenCalledWith('cid-1');
    expect(response.body).toBeInstanceOf(Buffer);
    expect(response.body.length).toBeGreaterThan(0);

    const archive = await new JSZip().loadAsync(response.body);
    expect(archive.file('chain.json')).toBeTruthy();
    expect(archive.file('eventChain.json')).toBeNull();
  });
});
