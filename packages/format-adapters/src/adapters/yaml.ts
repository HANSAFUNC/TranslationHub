import {
  ErrorCode,
  LocaleHubError,
  contentHash,
  extractPlaceholders,
  joinKey,
  type AdapterInput,
  type FormatAdapter,
  type NormalizedEntry,
  type RawEntry,
  type TranslationPatch,
} from '@localehub/contracts';
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';

/**
 * YAML adapter. YAML has no reliable in-place splice strategy for nested structures without
 * a formatting-preserving AST, so the adapter documents its policy explicitly:
 *
 *  - `applyPatch` uses the document API, which preserves comments and key order for
 *    untouched keys, and rewrites only the changed scalars.
 *  - blocks are patched by exact node path, so unknown sibling keys survive.
 */
export class YamlAdapter implements FormatAdapter {
  readonly id = 'yaml';
  readonly extensions = ['.yaml', '.yml'];

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (!/\.ya?ml$/i.test(filePath)) return false;
    try {
      parseYaml(content.toString('utf8'));
      return true;
    } catch {
      return false;
    }
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    let doc: unknown;
    try {
      doc = parseYaml(input.content.toString('utf8'));
    } catch (error) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, `Failed to parse YAML ${input.filePath}: ${(error as Error).message}`, 400);
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, `YAML root of ${input.filePath} must be a mapping`, 400);
    }
    const keyMode = input.keyMode ?? 'nested';
    const entries: RawEntry[] = [];
    const walk = (node: unknown, path: string[]) => {
      if (node === null || typeof node !== 'object') {
        if (typeof node === 'string' && path.length) {
          entries.push({
            key: keyMode === 'flat' ? (path[0] ?? '') : path.join('.'),
            value: node,
            locale: input.locale,
            namespace: input.namespace,
            platform: input.platform,
            placeholders: extractPlaceholders(node),
            filePath: input.filePath,
            ...(keyMode === 'nested' ? { platformMetadata: { yamlPath: path } } : {}),
          } satisfies RawEntry);
        }
        return;
      }
      if (Array.isArray(node)) return;
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key.startsWith('x-') || key.startsWith('_')) continue;
        walk(child, [...path, key]);
      }
    };
    walk(doc, []);
    return entries;
  }

  async validate(entries: NormalizedEntry[]) {
    const issues = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const id = `${entry.namespace}\u0001${entry.key}\u0001${entry.locale}`;
      if (seen.has(id)) {
        issues.push({
          code: 'DUPLICATE_KEY',
          severity: 'ERROR' as const,
          message: `Duplicate YAML key ${entry.key}`,
          key: entry.key,
          locale: entry.locale,
          filePath: entry.filePath,
        });
      }
      seen.add(id);
    }
    return issues;
  }

  async applyPatch(input: { originalContent: Buffer; changes: TranslationPatch[]; preserveUnknownFields: boolean }): Promise<Buffer> {
    const text = input.originalContent.toString('utf8');
    // The document API keeps comments, key order and blank lines of untouched nodes.
    const doc = parseDocument(text);
    for (const change of input.changes) {
      const path = (change as TranslationPatch & { yamlPath?: string[] }).yamlPath ?? change.key.split('.');
      doc.setIn(path, change.newValue);
    }
    return Buffer.from(doc.toString({ lineWidth: 0 }), 'utf8');
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
        const path = (entry.platformMetadata?.yamlPath as string[] | undefined) ?? entry.key.split('.');
        let cursor: Record<string, unknown> = root;
        for (let i = 0; i < path.length - 1; i += 1) {
          const segment = path[i] as string;
          if (typeof cursor[segment] !== 'object' || cursor[segment] === null) cursor[segment] = {};
          cursor = cursor[segment] as Record<string, unknown>;
        }
        cursor[path[path.length - 1] as string] = entry.value;
      }
      return { filePath, format: this.id, locale: list[0]?.locale ?? '', content: stringifyYaml(root, { lineWidth: 0 }) };
    });
  }
}

export { contentHash, joinKey };
