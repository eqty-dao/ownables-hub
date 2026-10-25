import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from './common/config/config.service';
import { configureApp } from './app.bootstrap';

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
