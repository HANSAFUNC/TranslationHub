import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  MAX_MARKERS_PER_MOCKUP,
  McpScope,
  Role,
  localeTagSchema,
  markerSchema,
  platformSchema,
} from '@localehub/contracts';
import { z } from 'zod';
import { Actor, RequireRole, RequireScopes, type ActorContext } from '../../common/auth';
import { zodBody } from '../../common/zod.pipe';
import { RawResponse } from '../../common/response.interceptor';
import { MockupsService } from './mockups.service';

const listSchema = z.object({
  platform: platformSchema.optional(),
  /**
   * Adds `containsKey` to each row, for the editor's "does this screen show my entry?" question.
   * `namespace` is part of the answer: an entry is identified by (namespace, key), and matching the
   * key name alone says yes for a screen whose marker sits in a different namespace.
   */
  key: z.string().max(512).optional(),
  namespace: z.string().max(255).optional(),
});

const detailSchema = z.object({
  /** The locale whose translations the marker should be joined with. Omitted means source text only. */
  locale: localeTagSchema.optional(),
});

const uploadSchema = z.object({
  name: z.string().min(1).max(120),
  platform: platformSchema.optional(),
  /** The language the sketch's text is drawn in; normally the project's source locale. */
  locale: localeTagSchema,
  imageBase64: z.string().min(1),
  /**
   * Advisory: the format is read from the bytes, and a wrong claim cannot change the stored one. The
   * values are the ones the MCP tool accepts, so the same caller mistake is refused the same way on
   * both surfaces instead of being accepted here and rejected there.
   */
  mimeType: z.enum(['image/svg+xml', 'image/png', 'image/jpeg']).optional(),
  width: z.number().int().positive().max(8192).optional(),
  height: z.number().int().positive().max(8192).optional(),
  markers: z.array(markerSchema).min(1).max(MAX_MARKERS_PER_MOCKUP),
  replace: z.boolean().optional(),
});

export type MockupUploadBody = z.infer<typeof uploadSchema>;

/**
 * Screen mockups.
 *
 * The editor's 90% detail view reads three things from here: the list of screens, one screen's markers
 * joined with the translations of a locale, and the image bytes. Uploads arrive on the same paths so
 * the flow can be exercised without an MCP client — the MCP tool and `POST` run the same domain
 * function, so a sketch cannot be valid on one surface and invalid on the other.
 */
@Controller('projects/:projectId/mockups')
export class MockupsController {
  constructor(private readonly mockups: MockupsService) {}

  @Get()
  async list(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(listSchema)) query: z.infer<typeof listSchema>,
  ) {
    return this.mockups.list(actor, projectId, query);
  }

  @Get(':mockupId')
  async detail(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Param('mockupId') mockupId: string,
    @Query(zodBody(detailSchema)) query: z.infer<typeof detailSchema>,
  ) {
    return this.mockups.get(actor, projectId, mockupId, query.locale ?? null);
  }

  /**
   * The sketch itself. Raw bytes: an image wrapped in the JSON envelope is not an image.
   *
   * Served from the same origin as the API, which is what lets the dialog render it with a plain
   * `<img>` under the caller's own credentials. The headers are part of the contract, not decoration:
   * an SVG is a document, and a browser that renders one from its own origin would run whatever is
   * inside it. `content-security-policy` with `sandbox` makes that impossible even on direct
   * navigation, `nosniff` stops a browser from second-guessing the content type this route sets, and
   * `cross-origin-resource-policy` allows the documented deployment where the web app calls the API
   * on another origin.
   */
  @RawResponse()
  @Get(':mockupId/image')
  async image(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Param('mockupId') mockupId: string,
    @Res() response: Response,
  ) {
    const meta = await this.mockups.imageMeta(actor, projectId, mockupId);
    const etag = `"${meta.contentHash.slice(0, 32)}"`;
    const mockup = response.req.headers['if-none-match'] === etag
      ? null
      : await this.mockups.image(actor, projectId, mockupId);
    if (!mockup) {
      // A 304 still has to describe what it is the revalidation of (RFC 9110 §15.4.5): without the
      // ETag and the cache directive, a client or proxy that takes its freshness metadata from this
      // response has nothing to store and may treat the entry as heuristically cacheable — the
      // opposite of what the 200 says.
      response.setHeader('etag', etag);
      response.setHeader('cache-control', 'private, no-cache');
      response.status(304).end();
      return;
    }
    // Handed to the socket as the `Uint8Array` Prisma returned rather than copied into a Buffer: the
    // bytes can be megabytes, and `res.end` accepts a Uint8Array directly.
    const bytes = Buffer.from(mockup.image.buffer, mockup.image.byteOffset, mockup.image.byteLength);
    response.setHeader('content-type', meta.mimeType);
    response.setHeader('content-length', String(bytes.length));
    response.setHeader('etag', etag);
    // `no-cache` means "revalidate", not "do not store": a screen can be replaced under the same name,
    // and the etag above is what makes revalidating cheap.
    response.setHeader('cache-control', 'private, no-cache');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    response.setHeader('cross-origin-resource-policy', 'cross-origin');
    response.end(bytes);
  }

  @Post()
  @RequireRole(Role.DEVELOPER)
  @RequireScopes(McpScope.SYNC_PUSH)
  async upload(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(uploadSchema)) body: MockupUploadBody,
  ) {
    return this.mockups.upload(actor, projectId, body);
  }

  @Delete(':mockupId')
  @RequireRole(Role.DEVELOPER)
  // The same scope as the upload: a token that may not put a sketch on the platform should not be
  // able to take one off it either.
  @RequireScopes(McpScope.SYNC_PUSH)
  async remove(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Param('mockupId') mockupId: string,
  ) {
    return this.mockups.remove(actor, projectId, mockupId);
  }
}
