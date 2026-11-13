import type { Prisma } from '@localehub/database';
import {
  ErrorCode,
  LocaleHubError,
  MAX_MARKERS_PER_MOCKUP,
  MAX_MOCKUP_BYTES,
  MAX_MOCKUP_DIMENSION,
  canonicalizeLocaleTag,
  detectImageType,
  imageDimensions,
  isValidLocaleTag,
  normalizeMarker,
  unsafeSvgReasons,
  type MockupImageType,
  type MockupMarkerInput,
  type PlatformName,
  type ReviewStatus,
} from '@localehub/contracts';
import { createHash } from 'node:crypto';

/**
 * Screen mockups: the half of context a translation key cannot carry.
 *
 * A key says what a string is. It cannot say where it appears, so `checkout.pay_now` reaches a
 * translator as a sentence with no button under it. A mockup uploads the missing half — a sketch of
 * the screen plus a marker per key — and the editor puts the two side by side.
 *
 * This module is the single implementation behind both surfaces that accept an upload: the Remote
 * MCP tool `upload_screen_mockup` and `POST /projects/:projectId/mockups`. The API and the MCP server
 * are separate processes talking to the same database, so a second copy of "which bytes are
 * acceptable" would be a second answer to a question that has one.
 */

export interface DecodedMockupImage {
  bytes: Buffer;
  mimeType: MockupImageType;
  /** What the caller claimed, when it claimed something. Kept for the response, never for the row. */
  declaredMimeType: string | null;
  width: number | null;
  height: number | null;
}

// A data URL may carry parameters between the media type and `;base64` — `data:image/svg+xml;charset=utf-8;base64,…`
// is what several exporters emit, and the earlier form of this pattern rejected it as "not valid base64",
// which told the caller its encoding was wrong when the real answer was 'that spelling is not supported'.
const DATA_URL = /^data:(?:[\w.+-]+\/[\w.+-]+)?(?:;[\w.+-]+=[\w.+-]*)*;base64,/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Turn what a caller sent into bytes the platform is willing to store and serve.
 *
 * Every check here exists because the value is later handed back to a browser under a `content-type`
 * this function decides, and rendered in the editor:
 *
 *   - the format is read from the **bytes**, never from `mime_type`, so a caller cannot have a text
 *     file served as an image;
 *   - the size is checked before decoding, so an oversized payload is refused instead of allocated;
 *   - the pixel dimensions are read for every accepted format, so a small file that would decode into
 *     a gigantic canvas is refused by name;
 *   - an SVG that could act as a script is refused, listing the construct to remove. The editor also
 *     renders sketches through `<img>` and the API serves them under a restrictive CSP, but a sketch
 *     has no legitimate need for `<script>`, so the cheapest reliable answer is to not store one.
 */
export function decodeMockupImage(input: {
  imageBase64: string;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
}): DecodedMockupImage {
  const raw = input.imageBase64.trim().replace(DATA_URL, '').replace(/\s+/g, '');
  if (!raw) {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'image_base64 is empty', 422);
  }
  if (!BASE64.test(raw)) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      'image_base64 is not valid base64 (no line breaks, no url-safe alphabet)',
      422,
    );
  }
  // Checked before decoding: 4 base64 characters carry 3 bytes, so the decoded size is known up front
  // and an oversized payload never becomes an allocation.
  const estimated = Math.floor((raw.length * 3) / 4);
  if (estimated > MAX_MOCKUP_BYTES + 3) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `Mockup image is ${Math.round(estimated / 1024)} KB; the limit is ${Math.round(MAX_MOCKUP_BYTES / 1024)} KB`,
      413,
      { limitBytes: MAX_MOCKUP_BYTES, actualBytes: estimated },
    );
  }

  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length) {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'image_base64 decoded to zero bytes', 422);
  }
  if (bytes.length > MAX_MOCKUP_BYTES) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `Mockup image is ${Math.round(bytes.length / 1024)} KB; the limit is ${Math.round(MAX_MOCKUP_BYTES / 1024)} KB`,
      413,
      { limitBytes: MAX_MOCKUP_BYTES, actualBytes: bytes.length },
    );
  }

  const view = new Uint8Array(bytes);
  const mimeType = detectImageType(view);
  if (!mimeType) {
    throw new LocaleHubError(
      ErrorCode.UNSUPPORTED_FORMAT,
      'Unrecognised image: expected SVG, PNG or JPEG. WebP is not accepted — the server cannot read its dimensions.',
      422,
    );
  }

  if (mimeType === 'image/svg+xml') {
    const reasons = unsafeSvgReasons(new TextDecoder().decode(view));
    if (reasons.length) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        `This SVG cannot be stored because it contains ${reasons.join('、')}. Remove it and upload again — a sketch only needs shapes and text.`,
        422,
        { reasons },
      );
    }
  }

  const measured = imageDimensions(view, mimeType);
  const width = measured?.width ?? input.width ?? null;
  const height = measured?.height ?? input.height ?? null;
  return { bytes, mimeType, declaredMimeType: input.mimeType ?? null, width, height };
}

/** Throws when the caller's own dimensions — or the file's — describe a canvas too large to paint. */
export function assertMockupDimensions(image: DecodedMockupImage): void {
  if (image.width === null || image.height === null) return;
  if (image.width <= MAX_MOCKUP_DIMENSION && image.height <= MAX_MOCKUP_DIMENSION) return;
  // 413, not 422: the payload is well-formed and the caller did nothing wrong except export at a size
  // no browser should be asked to paint. The status is what tells a retry-on-4xx client to stop.
  throw new LocaleHubError(
    ErrorCode.VALIDATION_ERROR,
    `Mockup is ${image.width}×${image.height}; the limit is ${MAX_MOCKUP_DIMENSION}×${MAX_MOCKUP_DIMENSION}. ` +
      'Export the sketch at a sensible size — markers are fractions of the image, so a smaller export keeps every marker where it is.',
    413,
    { width: image.width, height: image.height, limit: MAX_MOCKUP_DIMENSION },
  );
}

export interface UpsertScreenMockupInput {
  organizationId: string;
  projectId: string;
  userId: string | null;
  name: string;
  platform: PlatformName;
  locale: string;
  image: DecodedMockupImage;
  markers: MockupMarkerInput[];
  /** Superseded by `replace` on the tool: the caller has already regenerated the screen. */
  replace: boolean;
}

export interface UnmatchedMarker {
  key: string;
  namespace: string;
  /** Why the marker is not shown next to a translation yet. */
  reason: 'KEY_NOT_IMPORTED';
}

export interface UpsertScreenMockupResult {
  mockupId: string;
  name: string;
  platform: string;
  locale: string;
  replaced: boolean;
  image: { mimeType: string; byteSize: number; width: number | null; height: number | null; checksum: string };
  markers: { total: number; matchedKeys: number; unmatched: UnmatchedMarker[] };
  /** What the editor adds to a relative path to fetch the image. */
  imagePath: string;
}

/**
 * Create or replace a screen mockup, and report which of its markers point at nothing.
 *
 * Unmatched markers are stored, not rejected. A sketch is frequently uploaded while the caller is
 * still reading the repository, so pointing at a key the platform has not imported yet describes the
 * UI truthfully; the editor shows those markers as "平台还没有这个 Key", and a later import makes
 * them light up. Rejecting the upload instead would mean the sketch can only be drawn after the
 * translations exist, which is the opposite of when it is useful.
 */
export async function upsertScreenMockup(
  tx: Prisma.TransactionClient,
  input: UpsertScreenMockupInput,
): Promise<UpsertScreenMockupResult> {
  if (!isValidLocaleTag(input.locale)) {
    throw new LocaleHubError(ErrorCode.INVALID_LOCALE, `Invalid locale: ${input.locale}`, 422);
  }
  const locale = canonicalizeLocaleTag(input.locale);
  if (!input.markers.length) {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'A mockup needs at least one marker', 422);
  }
  if (input.markers.length > MAX_MARKERS_PER_MOCKUP) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `${input.markers.length} markers exceeds the limit of ${MAX_MARKERS_PER_MOCKUP} per screen`,
      422,
    );
  }
  assertMockupDimensions(input.image);

  // The project has to exist *inside this tenant's scope* before anything is written against it.
  //
  // RLS makes another organization's project invisible, so this lookup is exactly "is this project
  // ours?". Skipping it did two things, both reproduced against the running stack: a member of
  // organization A could upload a sketch against organization B's project id (the row was written,
  // invisible to B, but the global unique index `(project_id, platform, name)` is not tenant-scoped,
  // so B could no longer use that screen name — an undeletable cross-tenant squat), and an unknown id
  // reached the foreign key and surfaced as a 500 carrying raw Prisma text.
  const project = await tx.project.findUnique({ where: { id: input.projectId }, select: { id: true } });
  if (!project) {
    throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${input.projectId} not found`, 404);
  }

  const markers = input.markers.map(normalizeMarker);
  const checksum = createHash('sha256').update(input.image.bytes).digest('hex');

  const existing = await tx.screenMockup.findFirst({
    where: { projectId: input.projectId, platform: input.platform as never, name: input.name },
    select: { id: true },
  });
  if (existing && !input.replace) {
    throw new LocaleHubError(
      ErrorCode.CONFLICT,
      `A mockup named "${input.name}" already exists for ${input.platform}. Pass replace: true to overwrite it, or upload under a different name.`,
      409,
      { mockupId: existing.id, name: input.name, platform: input.platform },
    );
  }

  const data = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    name: input.name,
    platform: input.platform as never,
    locale,
    width: input.image.width,
    height: input.image.height,
    mimeType: input.image.mimeType,
    byteSize: input.image.bytes.length,
    contentHash: checksum,
    // `Uint8Array` rather than the `Buffer` we validated: Prisma 6 types a Bytes column as
    // `Uint8Array<ArrayBuffer>`, and a Buffer's backing store is `ArrayBufferLike`, which includes
    // SharedArrayBuffer. One copy per upload is cheaper than fighting the variance.
    image: new Uint8Array(input.image.bytes),
    createdById: input.userId,
  };

  // The write never decides *whether* it may replace — the read above does — and each intent gets the
  // statement that makes it true under concurrency:
  //
  //   - `replace: false` is a plain `create`. Only the unique index can tell two concurrent callers
  //     apart, and it does so atomically: the loser gets `P2002`, which the exception filter maps to
  //     409. A read-then-write let both pass the check and the second silently overwrote the first
  //     while reporting `replaced: false`.
  //   - `replace: true` is one raw `INSERT … ON CONFLICT DO UPDATE`. Prisma's own `upsert` is not
  //     enough here: with a nested relation in the `update` branch (`markers: { deleteMany: {} }`) it
  //     compiles to a SELECT followed by INSERT/UPDATE rather than a single conflict-handling
  //     statement, which reopens the very race it was chosen to close. The markers are cleared by
  //     their own delete instead of nesting, and the statement below is atomic by construction.
  //
  //     Column order follows `data`; the bytea is passed as-is and the enums cast from text.
  const mockupId = input.replace
    ? (
        await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO screen_mockups (
            id, organization_id, project_id, name, platform, locale,
            width, height, mime_type, byte_size, content_hash, image, created_by_id,
            created_at, updated_at
          )
          VALUES (
            gen_random_uuid(), ${data.organizationId}::uuid, ${data.projectId}::uuid, ${data.name},
            ${data.platform}::text::"PlatformKind", ${data.locale},
            ${data.width}, ${data.height}, ${data.mimeType}, ${data.byteSize},
            ${data.contentHash}, ${data.image}, ${data.createdById}::uuid,
            now(), now()
          )
          ON CONFLICT (project_id, platform, name) DO UPDATE SET
            organization_id = EXCLUDED.organization_id,
            locale = EXCLUDED.locale,
            width = EXCLUDED.width,
            height = EXCLUDED.height,
            mime_type = EXCLUDED.mime_type,
            byte_size = EXCLUDED.byte_size,
            content_hash = EXCLUDED.content_hash,
            image = EXCLUDED.image,
            created_by_id = EXCLUDED.created_by_id,
            updated_at = now()
          RETURNING id
        `
      )[0]!.id
    : (await tx.screenMockup.create({ data, select: { id: true } })).id;

  // Markers of a replaced screen go before the new ones arrive, outside the upsert for the reason
  // above. A freshly inserted row has none, so this is a no-op on the create path.
  if (input.replace) {
    await tx.screenMockupMarker.deleteMany({ where: { mockupId } });
  }

  // Resolve which markers name a key the project actually has, by (namespace, key) rather than by the
  // full identity.
  //
  // The platform is deliberately *not* part of this lookup. A key's identity includes its platform,
  // but the platform a caller names never reaches it today: `scanEntrySchema` has no `platform` field,
  // so both `toScanEntry` (the CLI) and the MCP import drop it and every key is stored as `web` —
  // verified against the database, where a project whose mappings declare `ios` holds 0 `ios` keys and
  // 2,792 `web` ones. Matching sketches on the platform would therefore fail for every sketch that
  // names the platform truthfully, which is the opposite of what the field is for. Markers match
  // textually, and the platform each one resolved to is reported so a mismatch stays visible.
  const keyNames = [...new Set(markers.map((marker) => marker.key))];
  const keys = await tx.translationKey.findMany({
    // `archivedAt: null`, like every other key read in the codebase. An archived key was dropped from
    // the repository, so a marker pointing at it is pointing at something the editor will not list —
    // counting it as matched told the caller a key was imported when it had been removed.
    where: { projectId: input.projectId, key: { in: keyNames }, archivedAt: null },
    select: { key: true, namespace: { select: { name: true } } },
  });
  const known = new Set(keys.map((row) => `${row.namespace.name}\u0000${row.key}`));

  const unmatched: UnmatchedMarker[] = [];
  const seen = new Set<string>();
  for (const marker of markers) {
    const identity = `${marker.namespace}\u0000${marker.key}`;
    if (known.has(identity) || seen.has(identity)) continue;
    seen.add(identity);
    unmatched.push({ key: marker.key, namespace: marker.namespace, reason: 'KEY_NOT_IMPORTED' });
  }

  await tx.screenMockupMarker.createMany({
    data: markers.map((marker) => ({
      organizationId: input.organizationId,
      mockupId,
      key: marker.key,
      namespace: marker.namespace,
      x: marker.x,
      y: marker.y,
      width: marker.width,
      height: marker.height,
      text: marker.text ?? null,
      note: marker.note ?? null,
    })),
  });

  const matchedKeys = new Set(
    markers.filter((marker) => known.has(`${marker.namespace}\u0000${marker.key}`)).map((m) => `${m.namespace}\u0000${m.key}`),
  ).size;

  return {
    mockupId,
    name: input.name,
    platform: input.platform,
    locale,
    replaced: Boolean(existing),
    image: {
      mimeType: input.image.mimeType,
      byteSize: input.image.bytes.length,
      width: input.image.width,
      height: input.image.height,
      checksum,
    },
    markers: { total: markers.length, matchedKeys, unmatched },
    // Relative to the API base, not absolute: the browser client is handed `/api/v1/...` and adds its
    // own base, so an absolute path here produced `/api/v1/api/v1/...` and a 404 the dialog could
    // only report as a broken sketch.
    imagePath: `/projects/${input.projectId}/mockups/${mockupId}/image`,
  };
}

export interface ScreenMockupSummary {
  id: string;
  name: string;
  platform: string;
  locale: string;
  width: number | null;
  height: number | null;
  mimeType: string;
  byteSize: number;
  markerCount: number;
  updatedAt: Date;
}

/** Screens of a project, newest first, without the image bytes. */
export async function listScreenMockups(
  tx: Prisma.TransactionClient,
  projectId: string,
  filters: { platform?: PlatformName } = {},
): Promise<ScreenMockupSummary[]> {
  const rows = await tx.screenMockup.findMany({
    where: { projectId, ...(filters.platform ? { platform: filters.platform as never } : {}) },
    // `image` is never selected here: a list of screens should not drag megabytes of bytes across the
    // wire, and Prisma returns every scalar column unless told otherwise.
    select: {
      id: true,
      name: true,
      platform: true,
      locale: true,
      width: true,
      height: true,
      mimeType: true,
      byteSize: true,
      updatedAt: true,
      _count: { select: { markers: true } },
    },
    orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform as string,
    locale: row.locale,
    width: row.width,
    height: row.height,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    markerCount: row._count.markers,
    updatedAt: row.updatedAt,
  }));
}

export interface ResolvedMarker {
  id: string;
  key: string;
  namespace: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  /** The text drawn in the sketch, as the uploader saw it. */
  text: string | null;
  note: string | null;
  /** The platform the key was actually found on; `null` when the key is not in the project. */
  platform: string | null;
  /** The platform's current source text for this key. `null` when the key is not in the project. */
  source: string | null;
  /** The translation in the requested locale. `null` when there is no entry for it yet. */
  entry: {
    entryId: string;
    value: string;
    status: ReviewStatus;
    revision: number;
    updatedAt: Date;
  } | null;
}

/**
 * Join a screen's markers with the source text and the translation they point at.
 *
 * Reads two rows per marker at most, in two queries rather than 2N, and reports what it could not
 * find instead of dropping it: "this marker has no key yet" and "this key has no translation in the
 * locale you are looking at" are different facts, and the editor shows them differently.
 *
 * Markers come back in reading order (top to bottom, left to right) so the numbered badges in the
 * dialog follow the screen rather than the order the caller happened to list them in.
 */
export async function resolveScreenMarkers(
  tx: Prisma.TransactionClient,
  params: { projectId: string; platform: string; markers: {
    id: string;
    key: string;
    namespace: string;
    x: number;
    y: number;
    width: number | null;
    height: number | null;
    text: string | null;
    note: string | null;
  }[]; locale: string | null },
): Promise<ResolvedMarker[]> {
  const ordered = [...params.markers].sort((a, b) => a.y - b.y || a.x - b.x);
  if (!ordered.length) return [];

  const keyNames = [...new Set(ordered.map((marker) => marker.key))];
  const keys = await tx.translationKey.findMany({
    // No platform filter — see the note in `upsertScreenMockup`: the field a caller sets never reaches
    // a key's stored platform today, so requiring it here would resolve nothing. Archived keys *are*
    // filtered: the editor's own list does not show them, and a sketch that presents one as current
    // would offer an 「在编辑器中打开」 that lands on a row the editor cannot display.
    where: { projectId: params.projectId, key: { in: keyNames }, archivedAt: null },
    select: {
      id: true,
      key: true,
      platform: true,
      namespace: { select: { name: true } },
      sourceVersions: { orderBy: { version: 'desc' }, take: 1, select: { value: true } },
    },
    // Deterministic when one key name exists on several platforms: the screen's platform wins, then
    // the order is fixed so two calls cannot disagree about which row a marker points at.
    orderBy: [{ platform: 'asc' }, { id: 'asc' }],
  });

  const byIdentity = new Map<string, typeof keys>();
  for (const row of keys) {
    const identity = `${row.namespace.name}\u0000${row.key}`;
    const bucket = byIdentity.get(identity);
    if (bucket) bucket.push(row);
    else byIdentity.set(identity, [row]);
  }
  /** The screen's own platform when the key exists there, otherwise the first row in platform order. */
  const pickKey = (identity: string) => {
    const bucket = byIdentity.get(identity);
    if (!bucket?.length) return null;
    return bucket.find((row) => (row.platform as string) === params.platform) ?? bucket[0]!;
  };

  // Canonicalised the same way the write path and the project's locale list are: entries are stored
  // under the canonical tag, so `?locale=EN-US` used to match nothing and report every string as
  // untranslated — a wrong answer with a 200, which is the hardest kind to notice.
  const locale = params.locale && isValidLocaleTag(params.locale) ? canonicalizeLocaleTag(params.locale) : params.locale;
  const entries = locale
    ? await tx.translationEntry.findMany({
        where: {
          projectId: params.projectId,
          localeCode: locale,
          keyId: { in: keys.map((row) => row.id) },
        },
        select: { id: true, keyId: true, value: true, status: true, revision: true, updatedAt: true },
      })
    : [];
  const entryByKeyId = new Map(entries.map((row) => [row.keyId, row]));

  return ordered.map((marker) => {
    const identity = `${marker.namespace}\u0000${marker.key}`;
    const row = pickKey(identity);
    const entry = row ? entryByKeyId.get(row.id) : undefined;
    return {
      id: marker.id,
      key: marker.key,
      namespace: marker.namespace,
      x: marker.x,
      y: marker.y,
      width: marker.width,
      height: marker.height,
      text: marker.text,
      note: marker.note,
      platform: (row?.platform as string | undefined) ?? null,
      source: row?.sourceVersions[0]?.value ?? null,
      entry: entry
        ? {
            entryId: entry.id,
            value: entry.value,
            status: entry.status as ReviewStatus,
            revision: entry.revision,
            updatedAt: entry.updatedAt,
          }
        : null,
    };
  });
}
