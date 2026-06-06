import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigService } from './common/config/config.service.js';
import { configureApp } from './app.bootstrap.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });

  await configureApp(app);
  const config = app.get<ConfigService>(ConfigService);
  const appConfig = config.getAppConfig();
  await app.listen(appConfig.port);
}

bootstrap();
