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
import { applyTextEdits, escapeXmlText, lineOfOffset, unescapeHtml, type TextEdit } from '../text-utils';

interface XliffUnit {
  id: string;
  source: string;
  target: string;
  note?: string;
  targetInner?: { start: number; end: number };
  targetEnd?: number;
  unitOffset: number;
  targetState?: string;
}

const UNIT = /<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/g;
const ATTR = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
const SOURCE = /<source[^>]*>([\s\S]*?)<\/source>/;
const TARGET = /<target([^>]*)>([\s\S]*?)<\/target>/;
const NOTE = /<note[^>]*>([\s\S]*?)<\/note>/;

export function parseXliff(text: string): XliffUnit[] {
  const units: XliffUnit[] = [];
  UNIT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UNIT.exec(text)) !== null) {
    const attrsRaw = match[1] ?? '';
    const body = match[2] ?? '';
    const bodyStart = match.index + match[0].indexOf('>') + 1;
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR.exec(attrsRaw)) !== null) attrs[attrMatch[1] ?? ''] = attrMatch[2] ?? '';

    const sourceMatch = SOURCE.exec(body);
    const targetMatch = TARGET.exec(body);
    const noteMatch = NOTE.exec(body);
    const unit: XliffUnit = {
      id: attrs.id ?? attrs.resname ?? '',
      source: unescapeHtml(sourceMatch?.[1] ?? '').trim(),
      target: unescapeHtml(targetMatch?.[2] ?? '').trim(),
      note: noteMatch?.[1]?.trim(),
      unitOffset: match.index,
    };
    if (targetMatch) {
      const targetStart = bodyStart + (targetMatch.index ?? 0) + targetMatch[0].indexOf('>') + 1;
      unit.targetInner = { start: targetStart, end: targetStart + (targetMatch[2] ?? '').length };
      unit.targetEnd = targetStart + (targetMatch[2] ?? '').length + '</target>'.length;
      ATTR.lastIndex = 0;
      let targetAttr: RegExpExecArray | null;
      while ((targetAttr = ATTR.exec(targetMatch[1] ?? '')) !== null) {
        if (targetAttr[1] === 'state') unit.targetState = targetAttr[2];
      }
    }
    units.push(unit);
  }
  return units;
}

export class XliffAdapter implements FormatAdapter {
  readonly id = 'xliff';
  readonly extensions = ['.xliff', '.xlf'];

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (/\.(xlf|xliff)$/i.test(filePath)) return true;
    return /<xliff\b/.test(content.toString('utf8'));
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    const text = input.content.toString('utf8');
    let units: XliffUnit[];
    try {
      units = parseXliff(text);
    } catch (error) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, `Failed to parse XLIFF ${input.filePath}: ${(error as Error).message}`, 400);
    }
    return units
      .filter((unit) => unit.id)
      .map((unit) => ({
        key: unit.id,
        value: unit.target,
        locale: input.locale,
        namespace: input.namespace,
        platform: input.platform,
        description: unit.note,
        placeholders: extractPlaceholders(unit.target || unit.source),
        platformMetadata: { xliff: true, source: unit.source, targetState: unit.targetState },
        filePath: input.filePath,
        line: lineOfOffset(text, unit.unitOffset),
      }));
  }

  async validate(entries: NormalizedEntry[]) {
    const issues = [];
    for (const entry of entries) {
      if (!entry.value) {
        issues.push({
          code: 'EMPTY_TARGET',
          severity: 'WARNING' as const,
          message: 'XLIFF target is empty',
          key: entry.key,
          locale: entry.locale,
          filePath: entry.filePath,
        });
      }
    }
    return issues;
  }

  async applyPatch(input: { originalContent: Buffer; changes: TranslationPatch[]; preserveUnknownFields: boolean }): Promise<Buffer> {
    const text = input.originalContent.toString('utf8');
    const units = parseXliff(text);
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const edits: TextEdit[] = [];
    for (const change of input.changes) {
      const unit = byId.get(change.key);
      if (!unit) continue;
      if (unit.targetInner) {
        edits.push({ start: unit.targetInner.start, end: unit.targetInner.end, text: escapeXmlText(change.newValue) });
      } else if (unit.targetEnd !== undefined) {
        edits.push({ start: unit.targetEnd, end: unit.targetEnd, text: `<target>${escapeXmlText(change.newValue)}</target>` });
      }
    }
    return Buffer.from(applyTextEdits(text, edits), 'utf8');
  }

  async serialize(entries: NormalizedEntry[]) {
    const grouped = new Map<string, NormalizedEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.filePath) ?? [];
      list.push(entry);
      grouped.set(entry.filePath, list);
    }
    return [...grouped.entries()].map(([filePath, list]) => {
      const body = list
        .map(
          (entry) =>
            `      <trans-unit id="${escapeXmlText(entry.key)}">\n        <source>${escapeXmlText(String(entry.platformMetadata?.source ?? entry.value))}</source>\n        <target>${escapeXmlText(entry.value)}</target>\n      </trans-unit>`,
        )
        .join('\n');
      return {
        filePath,
        format: this.id,
        locale: list[0]?.locale ?? '',
        content: `<?xml version="1.0" encoding="UTF-8"?>\n<xliff version="1.2">\n  <file source-language="en" target-language="${list[0]?.locale ?? ''}" datatype="plaintext" original="localehub">\n    <body>\n${body}\n    </body>\n  </file>\n</xliff>\n`,
      };
    });
  }
}
