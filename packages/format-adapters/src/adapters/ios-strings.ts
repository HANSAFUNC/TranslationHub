import {
  ErrorCode,
  LocaleHubError,
  extractPlaceholders,
  type AdapterInput,
  type FormatAdapter,
  type NormalizedEntry,
  type RawEntry,
  type TranslationPatch,
} from '@localehub/contracts';
import { applyTextEdits, escapeIosString, lineOfOffset, unescapeIosString, type TextEdit } from '../text-utils';

interface StringsEntry {
  key: string;
  value: string;
  comment?: string;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g;

/** Parse `"key" = "value";` lines, keeping offsets for in-place patching. */
export function parseAppleStrings(text: string): StringsEntry[] {
  const entries: StringsEntry[] = [];
  let pendingComment: string | undefined;
  let index = 0;
  let lineStart = 0;

  while (index < text.length) {
    // comments
    const rest = text.slice(index);
    const commentMatch = /^(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/.exec(rest);
    if (commentMatch) {
      const body = commentMatch[0];
      if (body.startsWith('/*')) pendingComment = body.slice(2, -2).trim();
      else pendingComment = body.slice(2).trim();
      index += body.length;
      continue;
    }
    if (rest.trimStart().length === 0) break;

    // read up to the terminating ';'
    const semi = findStatementEnd(text, index);
    if (semi === -1) break;
    const statement = text.slice(index, semi);

    const literals: { value: string; start: number; end: number }[] = [];
    STRING_LITERAL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STRING_LITERAL.exec(statement)) !== null) {
      literals.push({
        value: unescapeIosString(match[1] ?? ''),
        start: index + match.index,
        end: index + match.index + match[0].length,
      });
    }
    if (literals.length >= 2) {
      const keyToken = literals[0];
      const valueToken = literals[literals.length - 1];
      entries.push({
        key: keyToken.value,
        value: valueToken.value,
        comment: pendingComment,
        keyStart: keyToken.start,
        keyEnd: keyToken.end,
        valueStart: valueToken.start,
        valueEnd: valueToken.end,
      });
    }
    pendingComment = undefined;
    index = semi + 1;
    lineStart = index;
  }
  void lineStart;
  return entries;
}

function findStatementEnd(text: string, from: number): number {
  let inString = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === ';') return i;
  }
  return -1;
}

export class AppleStringsAdapter implements FormatAdapter {
  readonly id = 'ios-strings';
  readonly extensions = ['.strings'];

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (!/\.strings$/i.test(filePath)) return false;
    const text = content.toString('utf8');
    return /"[\s\S]*?"\s*=\s*"/.test(text) || text.trim() === '';
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    const text = input.content.toString('utf8');
    let parsed: StringsEntry[];
    try {
      parsed = parseAppleStrings(text);
    } catch (error) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, `Failed to parse ${input.filePath}: ${(error as Error).message}`, 400);
    }
    return parsed.map((entry) => ({
      key: entry.key,
      value: entry.value,
      locale: input.locale,
      namespace: input.namespace,
      platform: input.platform,
      description: entry.comment,
      placeholders: extractPlaceholders(entry.value),
      filePath: input.filePath,
      line: lineOfOffset(text, entry.keyStart),
    }));
  }

  async validate(entries: NormalizedEntry[]) {
    const issues = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.key)) {
        issues.push({
          code: 'DUPLICATE_KEY',
          severity: 'ERROR' as const,
          message: `Duplicate .strings key ${entry.key}`,
          key: entry.key,
          locale: entry.locale,
          filePath: entry.filePath,
        });
      }
      seen.add(entry.key);
    }
    return issues;
  }

  async applyPatch(input: { originalContent: Buffer; changes: TranslationPatch[]; preserveUnknownFields: boolean }): Promise<Buffer> {
    const text = input.originalContent.toString('utf8');
    const parsed = parseAppleStrings(text);
    const byKey = new Map(parsed.map((entry) => [entry.key, entry]));
    const edits: TextEdit[] = [];
    const insertions: string[] = [];
    for (const change of input.changes) {
      const found = byKey.get(change.key);
      if (found) {
        edits.push({ start: found.valueStart, end: found.valueEnd, text: `"${escapeIosString(change.newValue)}"` });
      } else {
        insertions.push(`"${escapeIosString(change.key)}" = "${escapeIosString(change.newValue)}";`);
      }
    }
    let out = applyTextEdits(text, edits);
    if (insertions.length) {
      const suffix = insertions.join('\n');
      out = out.endsWith('\n') || out.length === 0 ? `${out}${suffix}\n` : `${out}\n${suffix}\n`;
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
    return [...grouped.entries()].map(([filePath, list]) => ({
      filePath,
      format: this.id,
      locale: list[0]?.locale ?? '',
      content: `${list
        .map((entry) => (entry.description ? `/* ${entry.description} */\n` : '') + `"${escapeIosString(entry.key)}" = "${escapeIosString(entry.value)}";`)
        .join('\n')}\n`,
    }));
  }
}
