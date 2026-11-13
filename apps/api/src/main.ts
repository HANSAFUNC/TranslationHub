import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { json, type NextFunction, type Request, type Response } from 'express';
import { ErrorCode } from '@localehub/contracts';
import { contextRequestId } from './common/request-context';
import { corsOrigins, loadEnv } from '@localehub/config';
import { AppModule } from './app.module';

/**
 * The request-body ceiling for a mockup upload.
 *
 * `MAX_MOCKUP_BYTES` is 2 MB of image, base64 expands it by ~4/3, and the rest of the request is the
 * marker list — 4 MB is the same figure the MCP transport enforces, so the two surfaces agree about
 * what "too big" means.
 */
const MOCKUP_BODY_LIMIT = '4mb';

/**
 * The parser itself, kept behind a name Nest does not recognise as its own JSON parser.
 *
 * See the note where it is mounted: a layer called `jsonParser` in the stack makes Nest skip
 * registering the app-wide parser altogether.
 */
const mockupJson = json({ limit: MOCKUP_BODY_LIMIT });

/** Named anything but `jsonParser`: see where it is mounted. */
const mockupBodyParser = (request: Request, response: Response, next: NextFunction): void => {
  mockupJson(request, response, next);
};

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
  // A larger body limit, on one route.
  //
  // A screen mockup arrives as a base64 image (~4/3 its bytes), so the sketch route needs the same
  // 4 MB ceiling the MCP transport documents; the earlier fix for that raised the limit for *every*
  // route, which meant `/auth/login` and the rest buffered and parsed up to 4 MB before AuthGuard or
  // the rate limiter ran. This parser is registered first (middleware added here runs before Nest's
  // own), and body-parser skips a request whose body is already parsed, so every other route keeps
  // Express's 100 kB default.
  //
  // The wrapper is load-bearing, not decoration. Nest decides whether to register its own app-wide
  // JSON parser by looking for a middleware layer named `jsonParser` — which is exactly what
  // `json(…)` is — so mounting it directly here made Nest skip its parser entirely and left every
  // route outside this one with `request.body === undefined` (`/auth/login` answered 422 to a valid
  // password, and the rate limiter's per-account bucket collapsed to one shared "unknown" bucket).
  // Two anonymous wrapper layers keep Nest's own parser, which then skips a body this one already
  // read.
  //
  // Mounted after `enableCors` on purpose: a request refused here — too large, or malformed — is
  // answered by this middleware, and the browser needs the CORS headers to be able to read that
  // answer at all in the documented cross-origin deployment.
  app.use(
    '/api/v1/projects/:projectId/mockups',
    (request: Request, response: Response, next: NextFunction) => mockupBodyParser(request, response, next),
    // A middleware mounted by hand runs outside Nest's exception filter, so a refusal here has to be
    // written in the same envelope every other failure uses — otherwise a 413 arrives as Express's
    // default HTML page and the client's error handling has nothing to render.
    (error: { status?: number; type?: string; message?: string }, request: Request, response: Response, next: NextFunction) => {
      if (!error) return next();
      const status = typeof error.status === 'number' && error.status >= 400 ? error.status : 400;
      response.status(status).json({
        success: false,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: error.message ?? 'Invalid request body',
          requestId: contextRequestId(),
        },
      });
    },
  );
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
