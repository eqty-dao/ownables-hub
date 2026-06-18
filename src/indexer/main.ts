import { NestFactory } from '@nestjs/core';
import { IndexerModule } from './indexer.module.js';
import { IndexerService } from './indexer.service.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(IndexerModule);
  try {
    const indexerService = app.get(IndexerService);
    await indexerService.runAllSlots();
  } finally {
    await app.close();
  }
}

bootstrap();
