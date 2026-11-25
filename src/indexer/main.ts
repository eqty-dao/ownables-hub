import { NestFactory } from '@nestjs/core';
import { ConfigService } from '../common/config/config.service';
import { IndexerModule } from './indexer.module';
import { IndexerService } from './indexer.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(IndexerModule);
  try {
    const indexerService = app.get(IndexerService);
    if (process.argv.includes('--active-slot')) {
      await indexerService.runSlot(app.get(ConfigService).getActiveIndexerSlot());
    } else {
      await indexerService.runAllSlots();
    }
  } finally {
    await app.close();
  }
}

bootstrap();
