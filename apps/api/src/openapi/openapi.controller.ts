import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/auth';
import { RawResponse } from '../common/response.interceptor';
import { buildOpenApiDocument, type OpenApiDocument } from './document';

/**
 * The API describes itself.
 *
 * Public on purpose: it is the document a client reads *before* it has a credential. It contains
 * no secrets — every value in it comes from decorators, and the schemas are the same ones the
 * validation pipe applies to untrusted input.
 */
@Controller()
export class OpenApiController {
  private cached: OpenApiDocument | null = null;

  @Public()
  @RawResponse()
  @Get('openapi.json')
  document(@Res({ passthrough: true }) response: Response): OpenApiDocument {
    // Built once: the route table and guard metadata cannot change at runtime.
    if (!this.cached) this.cached = buildOpenApiDocument({ serverUrl: '/api/v1' });
    response.header('cache-control', 'public, max-age=300');
    return this.cached;
  }
}
