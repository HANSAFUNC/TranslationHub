import {
  ErrorCode,
  LocaleHubError,
  contentHash,
  extractPlaceholders,
  type AdapterInput,
  type FormatAdapter,
  type NormalizedEntry,
  type RawEntry,
  type TranslationPatch,
  type ValidationIssue,
} from '@localehub/contracts';
import { JsonScanner, PATH_SEP, joinPath, type JsonScanResult } from './json-scan';

export interface JsonAdapterOptions {
  /** dotted keys are produced from nested objects (default) or used literally */
  keyMode?: 'nested' | 'flat';
  namespaceFromPath?: boolean;
}

/**
 * JSON adapter.
 *
 * Parse is read-only and never rewrites the file. applyPatch performs surgical token
 * replacement so that formatting, comments-as-keys, key order and unknown metadata survive.
 */
export class JsonAdapter implements FormatAdapter {
  readonly id = 'json';
  readonly extensions = ['.json', '.jsonc'];

  constructor(private readonly options: JsonAdapterOptions = {}) {}

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (!/\.jsonc?$/i.test(filePath)) return false;
    try {
      new JsonScanner(content.toString('utf8')).scan();
      return true;
    } catch {
      return false;
    }
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    const text = input.content.toString('utf8');
    let scan: JsonScanResult;
    try {
      scan = new JsonScanner(text).scan();
    } catch (error) {
      throw new LocaleHubError(
        ErrorCode.PARSE_ERROR,
        `Failed to parse JSON file ${input.filePath}: ${(error as Error).message}`,
        400,
        { filePath: input.filePath },
      );
    }
    const keyMode = input.keyMode ?? this.options.keyMode ?? 'nested';
    const entries: RawEntry[] = [];
    const root = scan.root;
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, `JSON root of ${input.filePath} must be an object`, 400);
    }
    const namespace = input.namespaceFromPath ?? this.options.namespaceFromPath
      ? input.namespace
      : input.namespace;

    walk(root as Record<string, unknown>, [], (path, value) => {
      if (typeof value !== 'string') return;
      const key = keyMode === 'flat' ? String(path[0] ?? '') : path.join('.');
      if (!key) return;
      const line = lineOfOffset(text, scan.spans.get(joinPath(path))?.start ?? 0);
      entries.push({
        key,
        value,
        locale: input.locale,
        namespace,
        platform: input.platform,
        placeholders: extractPlaceholders(value),
        platformMetadata: keyMode === 'flat' ? undefined : { jsonPath: path },
        filePath: input.filePath,
        line,
      });
    });

    return entries;
  }

  async validate(entries: NormalizedEntry[]): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const seen = new Map<string, NormalizedEntry>();
    for (const entry of entries) {
      if (entry.value.trim() === '') {
        issues.push({
          code: 'EMPTY_VALUE',
          severity: 'WARNING',
          message: 'Translation value is empty',
          key: entry.key,
          locale: entry.locale,
          filePath: entry.filePath,
        });
      }
      const dedupe = `${entry.namespace}\u0001${entry.key}\u0001${entry.locale}`;
      if (seen.has(dedupe)) {
        issues.push({
          code: 'DUPLICATE_KEY',
          severity: 'ERROR',
          message: `Duplicate key ${entry.key} for locale ${entry.locale}`,
          key: entry.key,
          locale: entry.locale,
          filePath: entry.filePath,
        });
      }
      seen.set(dedupe, entry);
    }
    return issues;
  }

  /**
   * In-place patch. Returns the new file content.
   * Throws when a requested change targets a non-existent path in `flat` mode or an
   * incompatible value type; callers must treat that as a hard failure (no partial writes
   * within a single file — the file is rebuilt atomically by the caller).
   */
  async applyPatch(input: {
    originalContent: Buffer;
    changes: TranslationPatch[];
    preserveUnknownFields: boolean;
  }): Promise<Buffer> {
    const text = input.originalContent.toString('utf8');
    const scan = new JsonScanner(text).scan();
    const edits: { start: number; end: number; text: string }[] = [];
    const insertions = new Map<string, { parentPath: (string | number)[]; members: string[] }>();

    for (const change of input.changes) {
      const path = pathForChange(change);
      const pathKey = joinPath(path);
      const span = scan.spans.get(pathKey);
      if (span) {
        if (span.type !== 'string' && span.type !== 'object') {
          throw new LocaleHubError(
            ErrorCode.UNSUPPORTED_FORMAT,
            `JSON value at ${change.key} is a ${span.type}, only string and plural/variation objects can be patched`,
            422,
          );
        }
        if (span.type === 'object' && !change.variantPath?.length) {
          throw new LocaleHubError(
            ErrorCode.UNSUPPORTED_FORMAT,
            `JSON value at ${change.key} is an object; use variantPath for plural branches`,
            422,
          );
        }
        edits.push({ start: span.start, end: span.end, text: JSON.stringify(change.newValue) });
        continue;
      }
      // new key -> insert into the closest existing ancestor object, creating
      // intermediate objects when the namespace path does not exist yet.
      const anchor = findInsertionAnchor(scan, path);
      if (!anchor) {
        throw new LocaleHubError(
          ErrorCode.PARSE_ERROR,
          `Cannot insert new key ${change.key}: no enclosing object exists in ${change.locale}`,
          422,
        );
      }
      const indent = anchor.inner.indent;
      const memberIndent = indent.repeat(anchor.path.length + 1);
      const parentIsEmpty = anchor.inner.start === anchor.inner.end;
      const member = `${parentIsEmpty ? '' : ','}\n${memberIndent}${JSON.stringify(
        String(anchor.remaining[0]),
      )}: ${buildNestedValue(anchor.remaining.slice(1), JSON.stringify(change.newValue), indent, anchor.path.length + 1)}`;
      const existing = insertions.get(anchor.key);
      if (existing) existing.members.push(member);
      else insertions.set(anchor.key, { parentPath: anchor.path, members: [member] });
    }

    for (const [parentKey, group] of insertions) {
      const inner = scan.objectInnerSpans.get(parentKey);
      if (!inner) continue;
      // insert before the trailing whitespace/newline that precedes the closing brace
      const at = trimTrailingWhitespace(text, inner.start, inner.end);
      edits.push({ start: at, end: at, text: group.members.join('') });
    }

    edits.sort((a, b) => b.start - a.start);
    let out = text;
    for (const edit of edits) {
      out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    }
    return Buffer.from(out, 'utf8');
  }

  async serialize(entries: NormalizedEntry[]) {
    const grouped = new Map<string, NormalizedEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.filePath) ?? [];
      list.push(entry);
      grouped.set(entry.filePath, list);
    }
    return [...grouped.entries()].map(([filePath, list]) => {
      const root: Record<string, unknown> = {};
      for (const entry of list) {
        const path = pathFromKey(entry);
        let cursor = root;
        for (let i = 0; i < path.length - 1; i += 1) {
          const segment = String(path[i]);
          if (typeof cursor[segment] !== 'object' || cursor[segment] === null) cursor[segment] = {};
          cursor = cursor[segment] as Record<string, unknown>;
        }
        cursor[String(path[path.length - 1])] = entry.value;
      }
      return {
        filePath,
        format: this.id,
        locale: list[0]?.locale ?? '',
        content: `${JSON.stringify(root, null, 2)}\n`,
      };
    });
  }
}

/** Index of the last non-whitespace character inside an object body + 1. */
export function trimTrailingWhitespace(text: string, start: number, end: number): number {
  let at = end;
  while (at > start && /\s/.test(text[at - 1] ?? '')) at -= 1;
  return at;
}

/**
 * Walk up from the target path until an existing object is found.
 * Returns the anchor object plus the sub-path that still has to be created.
 */
function findInsertionAnchor(
  scan: JsonScanResult,
  path: (string | number)[],
): { key: string; path: (string | number)[]; remaining: (string | number)[]; inner: { start: number; end: number; indent: string } } | null {
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const candidate = path.slice(0, depth);
    const key = joinPath(candidate);
    const inner = scan.objectInnerSpans.get(key);
    if (inner) return { key, path: candidate, remaining: path.slice(depth), inner };
  }
  return null;
}

/** Serialise `{ a: { b: valueSource } }` with the file's indentation. */
function buildNestedValue(remaining: (string | number)[], valueSource: string, indent: string, depth: number): string {
  if (remaining.length === 0) return valueSource;
  const inner = `${indent.repeat(depth + 1)}${JSON.stringify(String(remaining[0]))}: ${buildNestedValue(
    remaining.slice(1),
    valueSource,
    indent,
    depth + 1,
  )}`;
  return `{\n${inner}\n${indent.repeat(depth)}}`;
}

function pathForChange(change: TranslationPatch): (string | number)[] {
  const metaPath = (change as TranslationPatch & { jsonPath?: unknown }).jsonPath;
  if (Array.isArray(metaPath) && metaPath.length) return metaPath as (string | number)[];
  const base = change.key.includes(PATH_SEP) ? change.key.split(PATH_SEP) : change.key.split('.');
  return change.variantPath?.length ? [...base, ...change.variantPath] : base;
}

function pathFromKey(entry: NormalizedEntry): (string | number)[] {
  const metaPath = entry.platformMetadata?.jsonPath;
  if (Array.isArray(metaPath) && metaPath.length) return metaPath as (string | number)[];
  return entry.key.split('.');
}

function walk(
  node: unknown,
  path: (string | number)[],
  visit: (path: (string | number)[], value: unknown) => void,
): void {
  if (node === null) return;
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, [...path, index], visit));
    return;
  }
  if (typeof node === 'object') {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith('@') || key.startsWith('_')) continue; // metadata convention
      walk(child, [...path, key], visit);
    }
    return;
  }
  visit(path, node);
}

function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

export { contentHash };
