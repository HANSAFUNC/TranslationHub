import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { ApiResponse } from '@localehub/contracts';

/**
 * Opt a route out of the envelope.
 *
 * The envelope is the API's contract (spec §8.4), but a document *describing* the API is not one
 * of its own resources: `GET /openapi.json` has to return the document itself, or every
 * OpenAPI-aware tool reads `{success, data:{openapi:…}}` and finds no `openapi` field.
 */
export const RAW_RESPONSE = 'rawResponse';
export const RawResponse = (): MethodDecorator => SetMetadata(RAW_RESPONSE, true);

/** Wrap successful responses in the documented envelope (spec §8.4). */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.get<boolean>(RAW_RESPONSE, context.getHandler());
    if (raw) return next.handle();

    return next.handle().pipe(
      map((data) => {
        if (data && typeof data === 'object' && 'success' in (data as Record<string, unknown>)) {
          return data as ApiResponse<unknown>;
        }
        return { success: true, data } satisfies ApiResponse<unknown>;
      }),
    );
  }
}
