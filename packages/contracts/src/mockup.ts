import { z } from 'zod';

/**
 * Screen mockups: a sketch of a UI plus where each key's text sits on it.
 *
 * The editor shows the sketch on the left and translations on the right; clicking a marker selects
 * that entry, and selecting an entry highlights its markers. Everything the two surfaces have to
 * agree on lives here — the geometry rules the API validates, the limits it enforces, and the format
 * list it accepts.
 *
 * Nothing in this module imports `node:crypto` or anything else Node-only: the web bundle imports it
 * while rendering, and a browser cannot resolve `node:` specifiers.
 */

/**
 * Accepted image formats.
 *
 * SVG is first because it is what a caller that *generates* a sketch will produce: it is text, a
 * wireframe is a few kilobytes, and it stays sharp at any size. PNG and JPEG cover the other half — a
 * real screenshot of the running app.
 *
 * WebP is deliberately absent rather than unsupported: the server reads every accepted format's pixel
 * dimensions to enforce `MAX_MOCKUP_DIMENSION`, and it cannot read WebP's. Accepting a format whose
 * size can only be taken on the caller's word would make that cap a claim instead of a check.
 */
export const MOCKUP_IMAGE_TYPES = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
} as const;

export type MockupImageType = keyof typeof MOCKUP_IMAGE_TYPES;

/**
 * A cap the request-body limit can live with.
 *
 * The MCP transport refuses bodies over 4 MB and base64 is ~4/3 its bytes, so anything above ~2.8 MB
 * could never arrive. 2 MB is the round number that leaves room for the rest of the request (markers,
 * a name) and is far more than either a wireframe or a compressed screenshot needs.
 */
export const MAX_MOCKUP_BYTES = 2 * 1024 * 1024;

/** Markers per screen. A screen with more than this is not a screen, it is an export. */
export const MAX_MARKERS_PER_MOCKUP = 400;

/**
 * Maximum image dimensions.
 *
 * The byte cap alone is not enough: a 200 KB PNG can be 30000×30000 if it is flat-colour, and the
 * browser has to decode and paint it at that size. Rejecting by name beats letting a tab die.
 */
export const MAX_MOCKUP_DIMENSION = 8192;

/**
 * Marker coordinates are fractions of the image, not pixels.
 *
 * A sketch rendered in a 400px dialog and the same sketch full screen must place the marker
 * identically, and a designer re-exporting at 2x must not invalidate every marker on the screen.
 * Both problems disappear when the coordinate system is the image itself.
 */
export const markerSchema = z
  .object({
    key: z.string().min(1).max(512),
    namespace: z.string().max(255).default(''),
    /** Left edge, as a fraction of image width (0 = left edge, 1 = right edge). */
    x: z.number().min(0).max(1),
    /** Top edge, as a fraction of image height. */
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1).optional(),
    height: z.number().min(0).max(1).optional(),
    /** The text as it appears in the sketch, so a mismatch against the platform value can be shown. */
    text: z.string().max(2000).optional(),
    note: z.string().max(1000).optional(),
  })
  .refine((marker) => marker.width === undefined || marker.x + marker.width <= 1.0001, {
    message: 'marker 的 x + width 超出图片右边（坐标是 0..1 的比例，不是像素）',
    path: ['width'],
  })
  .refine((marker) => marker.height === undefined || marker.y + marker.height <= 1.0001, {
    message: 'marker 的 y + height 超出图片下边（坐标是 0..1 的比例，不是像素）',
    path: ['height'],
  });

export type MockupMarkerInput = z.infer<typeof markerSchema>;

export interface MockupMarkerGeometry {
  key: string;
  namespace: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
}

/**
 * Normalise optional fields into nulls, so the stored shape does not depend on which optionals the
 * caller happened to send.
 */
export function normalizeMarker<T extends MockupMarkerInput>(
  marker: T,
): MockupMarkerGeometry & Omit<T, keyof MockupMarkerGeometry> {
  return {
    ...marker,
    namespace: marker.namespace ?? '',
    width: marker.width ?? null,
    height: marker.height ?? null,
  };
}

/**
 * Decide an image's real type from its bytes.
 *
 * The declared `mime_type` is caller-supplied and therefore a claim, not a fact. Reading magic bytes
 * costs nothing and is the difference between "we store what the caller said" and "we store what the
 * bytes are" — which matters, because these bytes are later served back to a browser under a
 * `content-type` this function decides.
 */
export function detectImageType(bytes: Uint8Array): MockupImageType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // SVG has no magic number, so it is recognised by its root element. The match is not anchored to
  // the first byte: a file exported by a design tool routinely opens with an XML declaration, an
  // `<!-- comment -->` or a DOCTYPE, and refusing those would reject exactly the sketches the guide
  // tells callers to produce. Only the first slice is decoded, so a large non-SVG file cannot make
  // this scan expensive.
  //
  // Escaped on purpose: a literal BOM is invisible to reviewers, and a BOM is exactly what an
  // XML-ish sketch tends to start with.
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '').trimStart();
  // `[\s/>]`: a sketch with no content at all is written `<svg/>`, and the `/` before `>` is not
  // whitespace.
  const root = /<svg[\s/>]/i.exec(head);
  if (!root) return null;
  // Everything before the root has to be something XML allows *before* a root element: whitespace, an
  // XML declaration, a DOCTYPE, comments. That is what keeps a random text file which merely mentions
  // `<svg` from being stored and later served under an image content-type.
  const prologue = head.slice(0, root.index);
  if (/^(?:\s|<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->)*$/i.test(prologue)) return 'image/svg+xml';
  return null;
}

/**
 * Constructs that make an uploaded SVG dangerous once a browser renders it.
 *
 * The editor renders sketches with `<img src=…>`, where SVG cannot run script, and the API serves
 * them under a restrictive `Content-Security-Policy` as a second layer. This list is the third: a
 * sketch has no legitimate need for any of it, so accepting one is a bug waiting for a browser that
 * behaves differently than expected. Rejecting says so, which is more useful to a caller than a
 * silently stripped file.
 */
const UNSAFE_SVG = [
  // `(?:[\w.-]+:)?` in each element pattern covers a namespace prefix: `<svg:script>` is the same
  // element as `<script>`, and an XML namespace is how it gets past a check that only knows the
  // unprefixed spelling. A sketch never needs a prefix, but a tool that emits one is still a sketch.
  { pattern: /<(?:[\w.-]+:)?script[\s>]/i, what: '<script> 元素' },
  { pattern: /<(?:[\w.-]+:)?foreignObject[\s>]/i, what: '<foreignObject> 元素（可以内嵌 HTML）' },
  { pattern: /<(?:[\w.-]+:)?(iframe|embed|object|audio|video)[\s>]/i, what: '可加载外部内容的元素' },
  { pattern: /\son[a-z]+\s*=/i, what: '事件属性（onclick 等）' },
  { pattern: /javascript:/i, what: 'javascript: 链接' },
  { pattern: /<!ENTITY/i, what: 'XML 实体声明（XXE）' },
  { pattern: /<\?xml-stylesheet/i, what: 'xml-stylesheet 处理指令' },
] as const;

/**
 * Reject a sketch that could act as a script rather than a picture.
 *
 * Returns the reasons rather than throwing, so the caller can be told exactly which construct to
 * remove — an agent regenerating the file needs to know what to change, and "invalid SVG" does not
 * tell it.
 */
export function unsafeSvgReasons(svg: string): string[] {
  return UNSAFE_SVG.filter((rule) => rule.pattern.test(svg)).map((rule) => rule.what);
}

/**
 * Read an SVG's intrinsic size from its `width`/`height` attributes or its `viewBox`.
 *
 * Recorded as metadata so the editor can reserve the right space before the image decodes. A sketch
 * without a readable size is still perfectly usable — `<img>` lays it out from the file itself — so
 * this returns null rather than failing.
 */
export function svgDimensions(svg: string): { width: number; height: number } | null {
  const head = svg.slice(0, 4000);
  // Only the root `svg` element's own attributes count. Scanning the whole slice finds `width=` on
  // any child — a `<rect width="300">`, or worse, `stroke-width="2"` on the root, whose `\b` boundary
  // matches after the hyphen and made a 375×667 sketch measure 2×667.
  const root = /<svg\b([^>]*)>/i.exec(head);
  if (!root) return null;
  const attributes = root[1]!;
  const viewBox = /viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(attributes);
  if (viewBox) {
    const width = Number(viewBox[3]);
    const height = Number(viewBox[4]);
    if (width > 0 && height > 0) return { width: Math.round(width), height: Math.round(height) };
  }
  // `(?<![\w-])` rather than `\b`: `stroke-width="2"` must not be read as the image width, and `\b`
  // treats the hyphen as a boundary.
  const width = /(?<![\w-])width\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i.exec(attributes);
  const height = /(?<![\w-])height\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i.exec(attributes);
  if (width && height) {
    const w = Math.round(Number(width[1]));
    const h = Math.round(Number(height[1]));
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return null;
}

/** Read a PNG's pixel dimensions out of its IHDR chunk. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return null;
  // The first chunk of a valid PNG is always IHDR at a fixed offset: 8-byte signature, 4-byte length,
  // 4-byte type, then width and height as big-endian uint32.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (type !== 'IHDR') return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) return null;
  return { width, height };
}

/**
 * Read a JPEG's pixel dimensions by walking its segment headers to the start-of-frame.
 *
 * Screenshots are the reason this exists: a 200 KB JPEG of a uniform background can be 20000×20000,
 * and the byte cap alone would wave it through to a browser that then has to decode it.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Padding fill bytes are legal between segments.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return null;
    // Start-of-frame markers hold the dimensions. DHT (0xc4), JPG (0xc8) and DAC (0xcc) share the
    // 0xc0-range but are not frames.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width && height ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** Pixel dimensions for every accepted format. `null` only when the file is malformed. */
export function imageDimensions(bytes: Uint8Array, type: MockupImageType): { width: number; height: number } | null {
  if (type === 'image/png') return pngDimensions(bytes);
  if (type === 'image/jpeg') return jpegDimensions(bytes);
  return svgDimensions(new TextDecoder().decode(bytes.subarray(0, 8192)));
}

/**
 * "Which screens show this key?" — asked by the editor when an entry is selected.
 *
 * Matching is textual (key + namespace) because a marker stores no `keyId`: the same key name can
 * belong to more than one platform (`web` and `ios` keys are separate rows) and a marker does not say
 * which, so callers that know the platform filter the result themselves.
 */
export function markerMatchesKey(marker: { key: string; namespace: string }, key: string, namespace = ''): boolean {
  return marker.key === key && (marker.namespace || '') === (namespace || '');
}
