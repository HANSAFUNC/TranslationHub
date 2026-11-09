import { createHash } from 'node:crypto';

/**
 * Canonical form of a translation value used for hashing.
 *
 * Spec §5.2: "JSON 对象键顺序、缩进、换行不应导致每条翻译都被识别为变化",
 * so the hash is computed over the *value* only, normalised for
 * - Unicode form (NFC)
 * - line endings (\r\n and \r -> \n)
 *
 * Trailing/leading spaces are significant in translations and therefore kept.
 */
export function normalizeValueForHash(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** content hash of a single translation value. */
export function contentHash(value: string): string {
  return sha256(`v1:${normalizeValueForHash(value)}`);
}

/** hash of a whole file, used only for file level change detection (never for entries). */
export function fileHash(content: string | Buffer): string {
  return sha256(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
}

/** Deterministic JSON serialisation: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha256 over the canonical JSON of a plan / payload (spec §9.2 plan_hash). */
export function hashObject(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

/** Deterministic identity of a normalised entry: project+platform+namespace+key+locale. */
export function entryIdentity(parts: {
  projectId: string;
  platform: string;
  namespace: string;
  key: string;
  locale: string;
}): string {
  return [parts.projectId, parts.platform, parts.namespace || '', parts.key, parts.locale].join('\u0001');
}

/** Short stable id used by local MCP for change ids inside a preview plan. */
export function shortId(prefix: string, identity: string): string {
  return `${prefix}_${sha256(identity).slice(0, 16)}`;
}
