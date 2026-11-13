import { Injectable } from '@nestjs/common';
import { ErrorCode, LocaleHubError, Role, type PlatformName } from '@localehub/contracts';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { decodeMockupImage, listScreenMockups, resolveScreenMarkers, upsertScreenMockup } from '@localehub/domain';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { MockupUploadBody } from './mockups.controller';

/**
 * Screen mockups, as the editor reads them.
 *
 * Uploads arrive here from two directions — this REST route and the Remote MCP tool
 * `upload_screen_mockup` — and both go through the same `@localehub/domain` functions, so a sketch
 * uploaded by an agent and one uploaded through the API cannot differ in validation, geometry or the
 * way unmatched markers are reported.
 */
@Injectable()
export class MockupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Screens of a project, without their bytes.
   *
   * `key` answers the question the editor actually asks — "does a screen show the entry I have
   * selected?" — by adding `containsKey` to every row rather than by filtering. The caller types a
   * key and wants the screens it can open; filtering would hide the screen list entirely when the
   * key appears nowhere, which reads as "no sketches were uploaded" instead of "this key is not
   * marked on any of them".
   */
  async list(
    actor: ActorContext,
    projectId: string,
    filters: { platform?: PlatformName; key?: string; namespace?: string },
  ) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const mockups = await listScreenMockups(tx, projectId, { platform: filters.platform });
      let containing = new Set<string>();
      if (filters.key) {
        // Matched on (namespace, key), which is what a marker actually points at. Matching the key
        // name alone answered "yes" for a screen whose only `title` marker is in another namespace,
        // and the dialog then opened that screen and highlighted a marker for a different entry.
        const rows = await tx.screenMockupMarker.findMany({
          where: {
            mockupId: { in: mockups.map((mockup) => mockup.id) },
            key: filters.key,
            namespace: filters.namespace ?? '',
          },
          select: { mockupId: true },
        });
        containing = new Set(rows.map((row) => row.mockupId));
      }
      return mockups.map((mockup) => ({
        ...mockup,
        // Relative to the API base. The MCP server and the API are addressed differently by different
        // clients, so an absolute path would be right for exactly one of them.
        imagePath: `/projects/${projectId}/mockups/${mockup.id}/image`,
        ...(filters.key ? { containsKey: containing.has(mockup.id) } : {}),
      }));
    });
  }

  /**
   * One screen: its metadata and every marker, joined with the source text and the translation in
   * `locale`. This is the whole payload the 90% detail view needs, in one request.
   */
  async get(actor: ActorContext, projectId: string, mockupId: string, locale: string | null) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const mockup = await tx.screenMockup.findFirst({
        where: { id: mockupId, projectId },
        // `image` is absent on purpose: the bytes travel on their own endpoint, so a JSON response
        // never carries a megabyte of base64 the client has to throw away.
        select: {
          id: true,
          name: true,
          platform: true,
          locale: true,
          width: true,
          height: true,
          mimeType: true,
          byteSize: true,
          contentHash: true,
          createdAt: true,
          updatedAt: true,
          markers: {
            select: {
              id: true,
              key: true,
              namespace: true,
              x: true,
              y: true,
              width: true,
              height: true,
              text: true,
              note: true,
            },
          },
        },
      });
      if (!mockup) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);

      const markers = await resolveScreenMarkers(tx, {
        projectId,
        platform: mockup.platform as string,
        markers: mockup.markers,
        // Omitted means "source text only": the caller may be showing the sketch against the original.
        locale,
      });

      return {
        mockup: {
          id: mockup.id,
          name: mockup.name,
          platform: mockup.platform as string,
          locale: mockup.locale,
          width: mockup.width,
          height: mockup.height,
          mimeType: mockup.mimeType,
          byteSize: mockup.byteSize,
          contentHash: mockup.contentHash,
          createdAt: mockup.createdAt,
          updatedAt: mockup.updatedAt,
          markerCount: markers.length,
          imagePath: `/projects/${projectId}/mockups/${mockup.id}/image`,
        },
        locale,
        markers,
      };
    });
  }

  /**
   * What the image route needs to answer `If-None-Match` — and nothing more.
   *
   * The response is `no-cache` with an ETag, so a browser revalidates on every open. Selecting only
   * the hash means a 304 costs a few bytes instead of pulling up to `MAX_MOCKUP_BYTES` out of the
   * BYTEA column and allocating it in this process just to throw it away.
   */
  async imageMeta(actor: ActorContext, projectId: string, mockupId: string) {
    assertRole(actor, projectId, Role.READONLY);
    const mockup = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.screenMockup.findFirst({
        where: { id: mockupId, projectId },
        select: { mimeType: true, contentHash: true },
      }),
    );
    if (!mockup) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);
    return mockup;
  }

  /** The bytes, for the `<img>` the dialog draws. Ownership is checked against the row, not the path. */
  async image(actor: ActorContext, projectId: string, mockupId: string) {
    assertRole(actor, projectId, Role.READONLY);
    const mockup = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.screenMockup.findFirst({
        where: { id: mockupId, projectId },
        select: { image: true },
      }),
    );
    if (!mockup) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);
    return mockup;
  }

  /**
   * Store a sketch. Same validation and same rows as the MCP tool, because it is the same function.
   *
   * The image decoder throws `LocaleHubError`s that already say which construct to remove or which
   * limit was passed; nothing here rewrites them, so a caller over either surface reads the same
   * sentence.
   */
  async upload(actor: ActorContext, projectId: string, body: MockupUploadBody) {
    assertRole(actor, projectId, Role.DEVELOPER);
    const image = decodeMockupImage({
      imageBase64: body.imageBase64,
      mimeType: body.mimeType ?? null,
      width: body.width ?? null,
      height: body.height ?? null,
    });

    const result = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      upsertScreenMockup(tx, {
        organizationId: actor.organizationId,
        projectId,
        userId: actor.userId,
        name: body.name,
        platform: body.platform ?? 'web',
        locale: body.locale,
        image,
        markers: body.markers,
        replace: body.replace ?? true,
      }),
    );

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType ?? 'user',
      action: 'mockup.upload',
      resourceType: 'screen_mockup',
      resourceId: result.mockupId,
      projectId,
      metadata: {
        name: result.name,
        platform: result.platform,
        locale: result.locale,
        markers: result.markers.total,
        unmatched: result.markers.unmatched.length,
        bytes: result.image.byteSize,
        via: 'api',
        // The same two fields the MCP tool records, so "which callers keep declaring the wrong type"
        // has one answer across both surfaces rather than only the agent-written half.
        detectedMimeType: result.image.mimeType,
        declaredMimeType: image.declaredMimeType,
      },
    });

    return result;
  }

  async remove(actor: ActorContext, projectId: string, mockupId: string) {
    assertRole(actor, projectId, Role.DEVELOPER);
    const removed = await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const mockup = await tx.screenMockup.findFirst({
        where: { id: mockupId, projectId },
        select: { id: true, name: true, platform: true },
      });
      if (!mockup) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);
      // Markers cascade from the mockup row by foreign key, so one delete is the whole screen.
      await tx.screenMockup.delete({ where: { id: mockup.id } });
      return mockup;
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType ?? 'user',
      action: 'mockup.delete',
      resourceType: 'screen_mockup',
      resourceId: removed.id,
      projectId,
      metadata: { name: removed.name, platform: removed.platform as string, via: 'api' },
    });

    return { deleted: true, mockupId: removed.id };
  }
}
