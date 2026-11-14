import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { ErrorFilter } from './http/error.filter';
import { JsonLogger } from './infrastructure/observability/logger';

export async function createApp(config = loadConfig(), logger = new JsonLogger()) {
  const app = await NestFactory.create(AppModule.forRoot(config, logger), { logger });
  app.useGlobalFilters(new ErrorFilter(logger));
  app.enableShutdownHooks(); // SIGTERM/SIGINT -> beforeApplicationShutdown -> onApplicationShutdown
  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
  new JsonLogger().info('http server listening', { port: config.port });
}
