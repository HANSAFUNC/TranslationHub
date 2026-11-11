import {
  ErrorCode,
  LocaleHubError,
  type AdapterInput,
  type FormatAdapter,
  type NormalizedEntry,
  type RawEntry,
  type TranslationPatch,
} from '@localehub/contracts';
import { applyTextEdits, type TextEdit } from '../text-utils';
import {
  assertWholeFile,
  resolveColumn,
  rowFromEntry,
  rowsToEntries,
  validateRows,
  type TabularRow,
} from './tabular';

/**
 * CSV adapter — bulk editing and import validation (spec §10.1).
 *
 * RFC 4180 with the conventions spreadsheets actually emit: quoted fields, doubled quotes inside
 * them, and either line ending. A BOM is tolerated on read; export writes one, because Excel on
 * Windows reads a BOM-less UTF-8 CSV as the system codepage and mangles every non-ASCII
 * translation.
 */

const CRLF = '\r\n';
const HEADER = ['key', 'namespace', 'locale', 'value', 'description'];

/** One parsed record with byte offsets per field, so patching can be surgical. */
interface CsvRecord {
  fields: { value: string; start: number; end: number }[];
}

export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fieldStart = 0;
  let fields: CsvRecord['fields'] = [];
  let value = '';
  let quoted = false;
  let i = 0;

  const pushField = (end: number) => {
    fields.push({ value, start: fieldStart, end });
    value = '';
  };
  const pushRecord = (end: number) => {
    pushField(end);
    records.push({ fields });
    fields = [];
  };

  while (i < text.length) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      value += char;
      i += 1;
      continue;
    }
    if (char === '"' && value === '') {
      quoted = true;
      fieldStart = i + 1;
      i += 1;
      continue;
    }
    if (char === ',') {
      pushField(i);
      fieldStart = i + 1;
      i += 1;
      continue;
    }
    if (char === '\n') {
      pushRecord(i);
      fieldStart = i + 1;
      i += 1;
      continue;
    }
    if (char === '\r' && text[i + 1] === '\n') {
      pushRecord(i);
      i += 2;
      fieldStart = i;
      continue;
    }
    value += char;
    i += 1;
  }
  if (fieldStart < text.length || fields.length || value !== '') pushRecord(text.length);
  return records;
}

/** Identity of a cell within a tabular file: a key alone is not unique. */
function identityOf(key: string, namespace: string, locale: string): string {
  return key + '\u0004' + namespace + '\u0004' + locale;
}

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

function cellsToRows(cells: string[][], filePath: string): TabularRow[] {
  if (!cells.length) return [];
  const header = cells[0]!.map(resolveColumn);
  if (!header.includes('key')) {
    throw new LocaleHubError(
      ErrorCode.UNSUPPORTED_FORMAT,
      filePath +
        ': the first row must be a header containing a "key" column (got: ' +
        (cells[0]!.join(', ') || '(empty)') +
        ')',
      422,
    );
  }
  const at = (row: string[], column: string) => {
    const index = header.indexOf(column as never);
    return index === -1 ? '' : (row[index] ?? '');
  };

  return (
    cells
      .slice(1)
      // Trailing blank lines are normal in a spreadsheet export and are not rows.
      .filter((row) => row.some((cell) => cell.trim() !== ''))
      .map((row) => ({
        key: at(row, 'key'),
        namespace: at(row, 'namespace'),
        locale: at(row, 'locale'),
        value: at(row, 'value'),
        description: at(row, 'description') || undefined,
      }))
  );
}

export class CsvAdapter implements FormatAdapter {
  readonly id = 'csv';
  readonly extensions = ['.csv'];

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (filePath.toLowerCase().endsWith('.csv')) return true;
    const firstLine = content.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
    return /(^|,)\s*(key|键)\s*(,|$)/i.test(firstLine);
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    const text = input.content.toString('utf8').replace(/^\uFEFF/, '');
    const rows = cellsToRows(
      parseCsv(text).map((record) => record.fields.map((field) => field.value)),
      input.filePath,
    );
    return rowsToEntries(rows, {
      filePath: input.filePath,
      platform: input.platform,
      defaultLocale: input.locale,
      defaultNamespace: input.namespace,
    }) as unknown as RawEntry[];
  }

  async validate(entries: NormalizedEntry[]) {
    return validateRows(
      entries.map((entry) => ({
        key: entry.key,
        namespace: entry.namespace,
        locale: entry.locale,
        value: entry.value,
        description: entry.description,
      })),
      'csv',
    );
  }

  /**
   * Rewrite the cells that changed, leaving every other byte alone.
   *
   * Line endings, quoting style and column order survive because only the matched fields are
   * replaced — the same reason the JSON adapter patches tokens instead of re-serializing.
   */
  async applyPatch(input: {
    originalContent: Buffer;
    changes: TranslationPatch[];
    preserveUnknownFields: boolean;
  }): Promise<Buffer> {
    const text = input.originalContent.toString('utf8');
    const bom = text.startsWith('\uFEFF') ? 1 : 0;
    const records = parseCsv(bom ? text.slice(1) : text);
    if (!records.length) assertWholeFile('An empty CSV');

    const header = records[0]!.fields.map((field) => resolveColumn(field.value));
    const keyIndex = header.indexOf('key');
    const valueIndex = header.indexOf('value');
    const namespaceIndex = header.indexOf('namespace');
    const localeIndex = header.indexOf('locale');
    if (keyIndex === -1 || valueIndex === -1) {
      throw new LocaleHubError(ErrorCode.UNSUPPORTED_FORMAT, 'CSV patch requires "key" and "value" columns', 422);
    }

    // A key repeats once per locale, and the same key can live in two namespaces, so a change is
    // identified by all three — matching on the key alone would patch the wrong row.
    const byIdentity = new Map<string, string>();
    for (const change of input.changes) {
      byIdentity.set(identityOf(change.key, change.namespace, change.locale), change.newValue);
    }

    const edits: TextEdit[] = [];
    for (const record of records.slice(1)) {
      const cells = record.fields.map((field) => field.value);
      const key = cells[keyIndex];
      if (key === undefined) continue;
      const namespace = namespaceIndex === -1 ? '' : (cells[namespaceIndex] ?? '');
      const locale = localeIndex === -1 ? '' : (cells[localeIndex] ?? '');
      const wanted = byIdentity.get(identityOf(key, namespace, locale));
      if (wanted === undefined) continue;
      const field = record.fields[valueIndex];
      if (!field) continue;
      edits.push({ start: field.start + bom, end: field.end + bom, text: escapeCell(wanted) });
    }

    if (!edits.length) return input.originalContent;
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
      content:
        '\uFEFF' +
        [HEADER, ...list.map(rowFromEntry)].map((cells) => cells.map(escapeCell).join(',')).join(CRLF) +
        CRLF,
    }));
  }
}
