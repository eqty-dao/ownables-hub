import { NestFactory } from '@nestjs/core';
import { IndexerModule } from './indexer.module';
import { IndexerService } from './indexer.service';

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
