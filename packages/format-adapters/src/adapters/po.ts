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
import { applyTextEdits, type TextEdit } from '../text-utils';

export interface PoBlock {
  context?: string;
  msgid: string;
  msgidPlural?: string;
  msgstr: string[];
  comments: { translator?: string; extracted?: string; reference?: string; flags?: string };
  /** [start, end) of each msgstr value token, quotes included */
  msgstrSpans: { start: number; end: number; index: number }[];
  startOffset: number;
}

const QUOTED = /"((?:[^"\\]|\\.)*)"/;

export function parsePo(text: string): PoBlock[] {
  const blocks: PoBlock[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let current: (Partial<PoBlock> & { msgstrSpans: PoBlock['msgstrSpans'] }) | null = null;
  let active: 'msgid' | 'msgid_plural' | 'msgstr' | 'msgctxt' | null = null;
  let activeIndex = 0;

  const flush = () => {
    if (current && current.msgid !== undefined) {
      blocks.push({
        context: current.context,
        msgid: current.msgid ?? '',
        msgidPlural: current.msgidPlural,
        msgstr: current.msgstr ?? [''],
        comments: current.comments ?? {},
        msgstrSpans: current.msgstrSpans ?? [],
        startOffset: current.startOffset ?? 0,
      });
    }
    current = null;
    active = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const lineLength = rawLine.length + 1;
    if (line.trim() === '') {
      flush();
      offset += lineLength;
      continue;
    }
    if (!current) {
      current = { msgstr: [''], msgstrSpans: [], comments: {}, startOffset: offset };
    }
    if (line.startsWith('#')) {
      const comments = current.comments ?? (current.comments = {});
      if (line.startsWith('#.')) comments.extracted = `${comments.extracted ?? ''}\n${line.slice(2).trim()}`.trim();
      else if (line.startsWith('#:')) comments.reference = `${comments.reference ?? ''} ${line.slice(2).trim()}`.trim();
      else if (line.startsWith('#,')) comments.flags = line.slice(2).trim();
      else if (line.startsWith('# ')) comments.translator = `${comments.translator ?? ''}\n${line.slice(2).trim()}`.trim();
      offset += lineLength;
      continue;
    }
    const keywordMatch = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+(.*)$/.exec(line);
    if (keywordMatch) {
      const keyword = keywordMatch[1] ?? '';
      const valuePart = keywordMatch[3] ?? '';
      const quoted = QUOTED.exec(valuePart);
      const value = quoted ? unescapePo(quoted[1] ?? '') : '';
      if (keyword === 'msgctxt') {
        current.context = value;
        active = 'msgctxt';
      } else if (keyword === 'msgid') {
        current.msgid = value;
        active = 'msgid';
      } else if (keyword === 'msgid_plural') {
        current.msgidPlural = value;
        active = 'msgid_plural';
      } else {
        activeIndex = keywordMatch[2] ? Number(keywordMatch[2]) : 0;
        current.msgstr = current.msgstr ?? [];
        current.msgstr[activeIndex] = value;
        const quoteStart = offset + line.indexOf('"');
        const quoteEnd = offset + line.lastIndexOf('"') + 1;
        current.msgstrSpans.push({ start: quoteStart, end: quoteEnd, index: activeIndex });
        active = 'msgstr';
      }
      offset += lineLength;
      continue;
    }
    if (line.startsWith('"')) {
      const quoted = QUOTED.exec(line.trim());
      if (quoted) {
        const value = unescapePo(quoted[1] ?? '');
        if (active === 'msgid') current.msgid = `${current.msgid ?? ''}${value}`;
        else if (active === 'msgid_plural') current.msgidPlural = `${current.msgidPlural ?? ''}${value}`;
        else if (active === 'msgctxt') current.context = `${current.context ?? ''}${value}`;
        else if (active === 'msgstr') {
          const msgstr = (current.msgstr ??= ['']);
          msgstr[activeIndex] = `${msgstr[activeIndex] ?? ''}${value}`;
          const span = current.msgstrSpans.find((s) => s.index === activeIndex);
          if (span) {
            span.end = offset + line.lastIndexOf('"') + 1;
          }
        }
      }
    }
    offset += lineLength;
  }
  flush();
  return blocks;
}

function unescapePo(value: string): string {
  return value.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return ch;
    }
  });
}

function escapePo(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

export class PoAdapter implements FormatAdapter {
  readonly id = 'po';
  readonly extensions = ['.po', '.pot'];

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (/\.(po|pot)$/i.test(filePath)) return true;
    return /^msgid\s+"/m.test(content.toString('utf8'));
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    let blocks: PoBlock[];
    try {
      blocks = parsePo(input.content.toString('utf8'));
    } catch (error) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, `Failed to parse PO ${input.filePath}: ${(error as Error).message}`, 400);
    }
    return blocks
      .filter((block) => block.msgid !== '')
      .map((block) => {
        const key = block.context ? `${block.context}\u0004${block.msgid}` : block.msgid;
        const plural = block.msgidPlural !== undefined && block.msgstr.length > 1;
        const value = plural
          ? buildIcuPlural({
              argName: 'count',
              quantities: Object.fromEntries(block.msgstr.map((text, index) => [PLURAL_ORDER[index] ?? `form${index}`, text])),
            })
          : (block.msgstr[0] ?? '');
        return {
          key,
          value,
          locale: input.locale,
          namespace: input.namespace,
          platform: input.platform,
          description: block.comments.extracted,
          context: block.comments.reference ? { developerComment: block.comments.reference } : undefined,
          placeholders: extractPlaceholders(value),
          platformMetadata: {
            po: true,
            plural,
            msgidPlural: block.msgidPlural,
            references: block.comments.reference,
            flags: block.comments.flags,
            translatorComment: block.comments.translator,
          },
          filePath: input.filePath,
        } satisfies RawEntry;
      });
  }

  async validate(entries: NormalizedEntry[]) {
    const issues = [];
    for (const entry of entries) {
      if (entry.value === '' && entry.isSource === false) {
        issues.push({
          code: 'UNTRANSLATED',
          severity: 'WARNING' as const,
          message: 'PO entry has an empty msgstr (untranslated)',
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
    const blocks = parsePo(text);
    const edits: TextEdit[] = [];
    for (const change of input.changes) {
      const block = blocks.find((candidate) => {
        const key = candidate.context ? `${candidate.context}\u0004${candidate.msgid}` : candidate.msgid;
        return key === change.key;
      });
      if (!block) continue;
      const plural = parseIcuPlural(change.newValue);
      if (plural && block.msgstr.length > 1) {
        for (const span of block.msgstrSpans) {
          const quantity = PLURAL_ORDER[span.index] ?? `form${span.index}`;
          const next = plural.quantities[quantity];
          if (typeof next === 'string') edits.push({ start: span.start, end: span.end, text: `"${escapePo(next)}"` });
        }
      } else {
        const span = block.msgstrSpans.find((s) => s.index === 0);
        const value = plural ? (plural.quantities.other ?? change.newValue) : change.newValue;
        if (span) edits.push({ start: span.start, end: span.end, text: `"${escapePo(value)}"` });
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
    return [...grouped.entries()].map(([filePath, list]) => ({
      filePath,
      format: this.id,
      locale: list[0]?.locale ?? '',
      content: `${list
        .map((entry) => {
          const plural = parseIcuPlural(entry.value);
          const [context, msgid] = entry.key.includes('\u0004') ? entry.key.split('\u0004') : [undefined, entry.key];
          const lines: string[] = [];
          if (entry.description) lines.push(`#. ${entry.description}`);
          if (context) lines.push(`msgctxt "${escapePo(context)}"`);
          lines.push(`msgid "${escapePo(msgid ?? '')}"`);
          if (plural) {
            lines.push(`msgid_plural "${escapePo(plural.quantities.other ?? '')}"`);
            Object.entries(plural.quantities).forEach(([, value], index) => lines.push(`msgstr[${index}] "${escapePo(value)}"`));
          } else {
            lines.push(`msgstr "${escapePo(entry.value)}"`);
          }
          return lines.join('\n');
        })
        .join('\n\n')}\n`,
    }));
  }
}

const PLURAL_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];
