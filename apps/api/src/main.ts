import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { corsOrigins, loadEnv } from '@localehub/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });

  // `trust proxy` decides whether X-Forwarded-For/Proto may be believed. It is off unless a
  // reverse proxy really is in front, because a client could otherwise spoof a fresh IP per
  // request and sidestep the rate limiter.
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));

  app.use(helmet());
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.enableCors({
    // Shares its source with the CSRF guard (`corsOrigins`), so the two cannot disagree.
    origin: corsOrigins(),
    credentials: true,
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? env.API_PORT ?? 3001), '0.0.0.0');
  Logger.log(`LocaleHub API listening on :${process.env.API_PORT ?? env.API_PORT ?? 3001}/api/v1`, 'Bootstrap');
}

/**
 * `TRUST_PROXY` accepts `true`/`false` (a hop count is also common). Defaults to off.
 */
function parseTrustProxy(value: string): boolean | number {
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : false;
}

bootstrap().catch((error) => {
  console.error('API failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
