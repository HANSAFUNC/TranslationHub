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
import { applyTextEdits, escapeXmlText, lineOfOffset, unescapeHtml, type TextEdit } from '../text-utils';

interface XmlStringNode {
  kind: 'string';
  name: string;
  attributes: Record<string, string>;
  value: string;
  innerStart: number;
  innerEnd: number;
  startOffset: number;
  comment?: string;
}

interface XmlPluralNode {
  kind: 'plurals';
  name: string;
  attributes: Record<string, string>;
  quantities: { quantity: string; value: string; innerStart: number; innerEnd: number }[];
  startOffset: number;
  comment?: string;
}

type XmlNode = XmlStringNode | XmlPluralNode;

const COMMENT = /<!--([\s\S]*?)-->/g;
const STRING_ELEMENT = /<string\b([^>]*?)(\/>|>([\s\S]*?)<\/string>)/g;
const PLURALS_ELEMENT = /<plurals\b([^>]*?)>([\s\S]*?)<\/plurals>/g;
const ITEM_ELEMENT = /<item\b([^>]*?)>([\s\S]*?)<\/item>/g;
const ATTR = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR.exec(raw)) !== null) attrs[match[1] ?? ''] = unescapeHtml(match[2] ?? '');
  return attrs;
}

/** Find the comment immediately preceding an offset (used as the developer description). */
function precedingComment(text: string, offset: number): string | undefined {
  const before = text.slice(0, offset);
  const matches = [...before.matchAll(COMMENT)];
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) return undefined;
  const between = before.slice(last.index + last[0].length);
  if (between.trim().length > 0) return undefined;
  return (last[1] ?? '').trim() || undefined;
}

export function parseAndroidXml(text: string): XmlNode[] {
  const nodes: XmlNode[] = [];
  const consumed: [number, number][] = [];

  PLURALS_ELEMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLURALS_ELEMENT.exec(text)) !== null) {
    const attrsRaw = match[1] ?? '';
    const body = match[2] ?? '';
    const bodyStart = match.index + match[0].indexOf('>') + 1;
    const quantities: XmlPluralNode['quantities'] = [];
    ITEM_ELEMENT.lastIndex = 0;
    let item: RegExpExecArray | null;
    while ((item = ITEM_ELEMENT.exec(body)) !== null) {
      const itemAttrs = parseAttributes(item[1] ?? '');
      const itemBody = item[2] ?? '';
      const innerStart = bodyStart + item.index + item[0].indexOf('>') + 1;
      quantities.push({
        quantity: itemAttrs.quantity ?? 'other',
        value: unescapeHtml(itemBody),
        innerStart,
        innerEnd: innerStart + itemBody.length,
      });
    }
    nodes.push({
      kind: 'plurals',
      name: parseAttributes(attrsRaw).name ?? '',
      attributes: parseAttributes(attrsRaw),
      quantities,
      startOffset: match.index,
      comment: precedingComment(text, match.index),
    });
    consumed.push([match.index, match.index + match[0].length]);
  }

  STRING_ELEMENT.lastIndex = 0;
  while ((match = STRING_ELEMENT.exec(text)) !== null) {
    const start = match.index;
    if (consumed.some(([from, to]) => start >= from && start < to)) continue;
    const attrsRaw = match[1] ?? '';
    const body = match[3] ?? '';
    const innerStart = body ? start + match[0].indexOf('>') + 1 : start + match[0].length;
    nodes.push({
      kind: 'string',
      name: parseAttributes(attrsRaw).name ?? '',
      attributes: parseAttributes(attrsRaw),
      value: unescapeHtml(body),
      innerStart,
      innerEnd: innerStart + body.length,
      startOffset: start,
      comment: precedingComment(text, start),
    });
  }

  return nodes.sort((a, b) => a.startOffset - b.startOffset);
}

export class AndroidXmlAdapter implements FormatAdapter {
  readonly id = 'android-xml';
  readonly extensions = ['.xml'];

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (!/\.xml$/i.test(filePath)) return false;
    if (!/(^|[/\\])values(-[A-Za-z0-9-]+)?[/\\]/.test(filePath) && !/strings\.xml$|plurals\.xml$/i.test(filePath)) {
      return false;
    }
    return /<resources[\s>]/.test(content.toString('utf8'));
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    const text = input.content.toString('utf8');
    let nodes: XmlNode[];
    try {
      nodes = parseAndroidXml(text);
    } catch (error) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, `Failed to parse Android XML ${input.filePath}: ${(error as Error).message}`, 400);
    }
    return nodes
      .filter((node) => node.name)
      .map((node) => {
        if (node.kind === 'plurals') {
          const quantities: Record<string, string> = {};
          for (const item of node.quantities) quantities[item.quantity] = item.value;
          const value = buildIcuPlural({ argName: 'count', quantities });
          return {
            key: node.name,
            value,
            locale: input.locale,
            namespace: input.namespace,
            platform: input.platform,
            description: node.comment,
            placeholders: extractPlaceholders(Object.values(quantities).join(' ')),
            platformMetadata: {
              androidTag: 'plurals',
              quantities,
              attributes: node.attributes,
            },
            filePath: input.filePath,
            line: lineOfOffset(text, node.startOffset),
          } satisfies RawEntry;
        }
        return {
          key: node.name,
          value: node.value,
          locale: input.locale,
          namespace: input.namespace,
          platform: input.platform,
          description: node.comment,
          placeholders: extractPlaceholders(node.value),
          platformMetadata: {
            androidTag: 'string',
            attributes: node.attributes,
            translatable: node.attributes.translatable !== 'false',
          },
          filePath: input.filePath,
          line: lineOfOffset(text, node.startOffset),
        } satisfies RawEntry;
      });
  }

  async validate(entries: NormalizedEntry[]) {
    const issues = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.key)) {
        issues.push({
          code: 'DUPLICATE_KEY',
          severity: 'ERROR' as const,
          message: `Duplicate Android resource name ${entry.key}`,
          key: entry.key,
          locale: entry.locale,
          filePath: entry.filePath,
        });
      }
      seen.add(entry.key);
      if (!/^[a-z0-9_]+$/.test(entry.key)) {
        issues.push({
          code: 'INVALID_RESOURCE_NAME',
          severity: 'ERROR' as const,
          message: `Android resource names must be lower_snake_case: ${entry.key}`,
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
    const nodes = parseAndroidXml(text);
    const byName = new Map(nodes.map((node) => [node.name, node]));
    const edits: TextEdit[] = [];
    const insertions: string[] = [];

    for (const change of input.changes) {
      const node = byName.get(change.key);
      if (node && node.kind === 'string') {
        if (parseIcuPlural(change.newValue)) {
          throw new LocaleHubError(
            ErrorCode.PLACEHOLDER_MISMATCH,
            `${change.key} is a <string> resource but the new value is a plural; use <plurals> mapping instead`,
            422,
          );
        }
        edits.push({ start: node.innerStart, end: node.innerEnd, text: escapeXmlText(change.newValue) });
        continue;
      }
      if (node && node.kind === 'plurals') {
        const parsed = parseIcuPlural(change.newValue);
        if (!parsed) {
          // a plain string replaces every quantity branch
          for (const item of node.quantities) {
            edits.push({ start: item.innerStart, end: item.innerEnd, text: escapeXmlText(change.newValue) });
          }
          continue;
        }
        for (const item of node.quantities) {
          const next = parsed.quantities[item.quantity];
          if (typeof next === 'string') {
            edits.push({ start: item.innerStart, end: item.innerEnd, text: escapeXmlText(next) });
          }
        }
        for (const [quantity, value] of Object.entries(parsed.quantities)) {
          if (!node.quantities.some((item) => item.quantity === quantity)) {
            const closing = text.lastIndexOf('</plurals>', node.quantities[0]?.innerEnd ?? text.length);
            if (closing > 0) {
              insertions.push(`    <item quantity="${quantity}">${escapeXmlText(value)}</item>\n`);
            }
          }
        }
        continue;
      }
      insertions.push(`  <string name="${change.key}">${escapeXmlText(change.newValue)}</string>`);
    }

    let out = applyTextEdits(text, edits);
    if (insertions.length) {
      const marker = '\n</resources>';
      const block = `${insertions.join('\n')}\n`;
      out = out.includes(marker) ? out.replace(marker, `\n${block}</resources>`) : `${out}\n${block}`;
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
      const body = list
        .map((entry) => {
          const plural = parseIcuPlural(entry.value);
          if (plural) {
            const items = Object.entries(plural.quantities)
              .map(([quantity, value]) => `    <item quantity="${quantity}">${escapeXmlText(value)}</item>`)
              .join('\n');
            return `  <plurals name="${entry.key}">\n${items}\n  </plurals>`;
          }
          return `  <string name="${entry.key}">${escapeXmlText(entry.value)}</string>`;
        })
        .join('\n');
      return {
        filePath,
        format: this.id,
        locale: list[0]?.locale ?? '',
        content: `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${body}\n</resources>\n`,
      };
    });
  }
}

/** Derive a locale from an Android resource directory name (values-ja, values-zh-rCN, ...). */
export function localeFromAndroidPath(filePath: string): string | null {
  const match = /values(?:-([A-Za-z0-9-]+))?[/\\]/.exec(filePath);
  if (!match) return null;
  const qualifier = match[1];
  if (!qualifier) return null;
  const parts = qualifier.split('-').filter((p) => !['land', 'port', 'sw600dp', 'night', 'v21', 'v26'].includes(p));
  return parts.map((p) => (p.startsWith('r') && p.length === 3 ? p.slice(1).toUpperCase() : p)).join('-') || null;
}
