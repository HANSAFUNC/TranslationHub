import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from './request-context';

/**
 * Every request gets a request id and an AsyncLocalStorage context.
 * All logs and audit rows carry it (spec §15).
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    const startedAt = Date.now();
    res.setHeader('x-request-id', requestId);
    requestContext.run({ requestId, startedAt, ip: req.ip, path: req.originalUrl }, () => next());
  }
}
