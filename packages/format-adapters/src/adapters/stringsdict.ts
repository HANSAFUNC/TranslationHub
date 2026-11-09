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
import { buildIcuPlural, parseIcuPlural } from '../icu';
import { applyTextEdits, escapeXmlText, unescapeHtml, type TextEdit } from '../text-utils';

interface StringsdictEntry {
  key: string;
  argName: string;
  formatKey: string;
  quantities: Record<string, { value: string; innerStart: number; innerEnd: number }>;
  valueTypeKey?: string;
  startOffset: number;
}

const KEY_ELEMENT = /<key>([\s\S]*?)<\/key>/g;
const STRING_ELEMENT = /<string>([\s\S]*?)<\/string>/g;
const DICT_OPEN = /<dict>/g;
const DICT_CLOSE = /<\/dict>/g;

/** Parse an Apple .stringsdict plist without a full plist parser, keeping offsets. */
export function parseStringsdict(text: string): StringsdictEntry[] {
  const entries: StringsdictEntry[] = [];
  const keys: { value: string; start: number; end: number }[] = [];
  KEY_ELEMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KEY_ELEMENT.exec(text)) !== null) {
    keys.push({ value: unescapeHtml(match[1] ?? ''), start: match.index, end: match.index + match[0].length });
  }

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const next = keys[i + 1];
    const segmentStart = key.end;
    const segmentEnd = next ? next.start : text.length;
    const segment = text.slice(segmentStart, segmentEnd);
    if (!segment.includes('<dict>')) continue;

    // find the nested plural dictionary: the first <dict> after the key
    const innerDictStart = text.indexOf('<dict>', segmentStart);
    if (innerDictStart === -1 || innerDictStart >= segmentEnd) continue;
    const innerDictEnd = matchingDictEnd(text, innerDictStart);
    if (innerDictEnd === -1) continue;
    const innerDict = text.slice(innerDictStart, innerDictEnd);

    const innerKeys: { value: string; end: number }[] = [];
    KEY_ELEMENT.lastIndex = 0;
    while ((match = KEY_ELEMENT.exec(innerDict)) !== null) {
      innerKeys.push({ value: unescapeHtml(match[1] ?? ''), end: innerDictStart + match.index + match[0].length });
    }

    const quantities: StringsdictEntry['quantities'] = {};
    let formatKey = '';
    let argName = 'count';
    let valueTypeKey: string | undefined;

    for (const innerKey of innerKeys) {
      const valueStart = innerKey.end;
      STRING_ELEMENT.lastIndex = 0;
      const stringMatch = STRING_ELEMENT.exec(text.slice(valueStart));
      if (!stringMatch) continue;
      const innerStart = valueStart + stringMatch.index + '<string>'.length;
      const innerEnd = innerStart + (stringMatch[1] ?? '').length;
      const value = unescapeHtml(stringMatch[1] ?? '');
      if (innerKey.value === 'NSStringLocalizedFormatKey') {
        formatKey = value;
        const argMatch = /%#@([A-Za-z0-9_]+)@/.exec(value);
        if (argMatch?.[1]) argName = argMatch[1];
      } else if (innerKey.value === 'NSStringFormatValueTypeKey') {
        valueTypeKey = value;
      } else if (!innerKey.value.startsWith('NSString')) {
        quantities[innerKey.value] = { value, innerStart, innerEnd };
      }
    }

    if (Object.keys(quantities).length === 0) continue;
    entries.push({
      key: key.value,
      argName,
      formatKey,
      quantities,
      valueTypeKey,
      startOffset: key.start,
    });
  }
  return entries;
}

function matchingDictEnd(text: string, dictStart: number): number {
  let depth = 0;
  let index = dictStart;
  while (index < text.length) {
    if (text.startsWith('<dict>', index)) {
      depth += 1;
      index += 6;
      continue;
    }
    if (text.startsWith('</dict>', index)) {
      depth -= 1;
      if (depth === 0) return index;
      index += 7;
      continue;
    }
    index += 1;
  }
  return -1;
}

export class StringsdictAdapter implements FormatAdapter {
  readonly id = 'ios-stringsdict';
  readonly extensions = ['.stringsdict'];

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (!/\.stringsdict$/i.test(filePath)) return false;
    return content.toString('utf8').includes('NSStringLocalizedFormatKey');
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    const text = input.content.toString('utf8');
    let parsed: StringsdictEntry[];
    try {
      parsed = parseStringsdict(text);
    } catch (error) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, `Failed to parse ${input.filePath}: ${(error as Error).message}`, 400);
    }
    return parsed.map((entry) => {
      const quantities = Object.fromEntries(Object.entries(entry.quantities).map(([q, v]) => [q, v.value]));
      const value = buildIcuPlural({ argName: entry.argName, quantities });
      return {
        key: entry.key,
        value,
        locale: input.locale,
        namespace: input.namespace,
        platform: input.platform,
        placeholders: extractPlaceholders(Object.values(quantities).join(' ')),
        platformMetadata: {
          stringsdict: true,
          formatKey: entry.formatKey,
          valueTypeKey: entry.valueTypeKey,
          quantities,
        },
        filePath: input.filePath,
      } satisfies RawEntry;
    });
  }

  async validate(entries: NormalizedEntry[]) {
    const issues = [];
    for (const entry of entries) {
      const quantities = (entry.platformMetadata?.quantities as Record<string, string> | undefined) ?? {};
      if (!quantities.other) {
        issues.push({
          code: 'MISSING_OTHER_QUANTITY',
          severity: 'ERROR' as const,
          message: `${entry.key} has no "other" plural branch, iOS falls back to it`,
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
    const parsed = parseStringsdict(text);
    const byKey = new Map(parsed.map((entry) => [entry.key, entry]));
    const edits: TextEdit[] = [];
    for (const change of input.changes) {
      const entry = byKey.get(change.key);
      if (!entry) {
        throw new LocaleHubError(
          ErrorCode.UNSUPPORTED_FORMAT,
          `Cannot create new .stringsdict entry ${change.key} automatically; add it to the catalog first`,
          422,
        );
      }
      const plural = parseIcuPlural(change.newValue);
      const quantities = plural ? plural.quantities : Object.fromEntries(Object.keys(entry.quantities).map((q) => [q, change.newValue]));
      for (const [quantity, item] of Object.entries(entry.quantities)) {
        const next = quantities[quantity];
        if (typeof next === 'string') edits.push({ start: item.innerStart, end: item.innerEnd, text: escapeXmlText(next) });
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
        .map((entry) => {
          const plural = parseIcuPlural(entry.value);
          const quantities = plural?.quantities ?? { other: entry.value };
          const items = Object.entries(quantities)
            .map(([quantity, value]) => `      <key>${quantity}</key>\n      <string>${escapeXmlText(value)}</string>`)
            .join('\n');
          return `    <key>${entry.key}</key>\n    <dict>\n      <key>NSStringLocalizedFormatKey</key>\n      <string>%#@${plural?.argName ?? 'count'}@</string>\n      <key>${plural?.argName ?? 'count'}</key>\n      <dict>\n        <key>NSStringFormatSpecTypeKey</key>\n        <string>NSStringPluralRuleType</string>\n        <key>NSStringFormatValueTypeKey</key>\n        <string>d</string>\n${items}\n      </dict>\n    </dict>`;
        })
        .join('\n');
      return {
        filePath,
        format: this.id,
        locale: list[0]?.locale ?? '',
        content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n${body}\n  </dict>\n</plist>\n`,
      };
    });
  }
}

export { DICT_CLOSE, DICT_OPEN };
