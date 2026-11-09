import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { loadEnv } from '@localehub/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.enableCors({
    origin: env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    credentials: true,
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? env.API_PORT ?? 3001), '0.0.0.0');
  Logger.log(`LocaleHub API listening on :${process.env.API_PORT ?? env.API_PORT ?? 3001}/api/v1`, 'Bootstrap');
}

bootstrap().catch((error) => {
  console.error('API failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
