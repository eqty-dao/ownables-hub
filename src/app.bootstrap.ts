import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import bodyParser from 'body-parser';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from './common/config/config.service.js';

const hubPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  description: string;
  version: string;
};

async function swagger(app: INestApplication, config: ConfigService) {
  const appConfig = config.getAppConfig();
  const options = new DocumentBuilder()
    .setTitle('Ownables Hub')
    .setDescription(hubPackage.description)
    .setVersion(hubPackage.version !== '0.0.0' ? hubPackage.version : appConfig.env)
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, options);
  SwaggerModule.setup('api-docs', app, document);
}

export async function configureApp(app: INestApplication): Promise<void> {
  const config = app.get<ConfigService>(ConfigService);
  const appConfig = config.getAppConfig();

  app.use(bodyParser.json({}), bodyParser.urlencoded({ extended: false }));
  app.enableShutdownHooks();
  app.enableCors({
    origin: appConfig.corsOrigins,
    credentials: false,
  });

  await swagger(app, config);
}
