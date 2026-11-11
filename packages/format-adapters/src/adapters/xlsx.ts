import ExcelJS from 'exceljs';
import {
  ErrorCode,
  LocaleHubError,
  type AdapterInput,
  type FormatAdapter,
  type NormalizedEntry,
  type RawEntry,
} from '@localehub/contracts';
import { assertWholeFile, resolveColumn, rowFromEntry, rowsToEntries, validateRows } from './tabular';

/**
 * XLSX adapter — bulk editing and import validation (spec §10.1).
 *
 * Same job as the CSV adapter, for the format product managers actually send back: a workbook with
 * a header row and one translation per line. The first worksheet is the one read; extra sheets are
 * ignored rather than guessed at, and the parse reports which sheet it used.
 *
 * **Import/export only.** `applyPatch` refuses. A workbook is a zip archive of XML parts, so
 * "change one cell" means regenerating the archive — there is no in-place edit that preserves what
 * the author did to the file, and a repository that stored XLSX as its source of truth could not
 * be written back safely anyway. The CSV adapter, which *can* patch surgically, is the format for
 * anything that round-trips into a repository.
 */

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel's own limit; a sheet that exceeds it is a mistake, not a translation file. */
const MAX_ROWS = 100_000;

export class XlsxAdapter implements FormatAdapter {
  readonly id = 'xlsx';
  readonly extensions = ['.xlsx'];

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (filePath.toLowerCase().endsWith('.xlsx')) return true;
    // Every xlsx is a zip, and every zip starts with PK\x03\x04. Checking more than that would
    // mean opening the archive, which `parse` does properly anyway.
    return content.length > 4 && content[0] === 0x50 && content[1] === 0x4b && content[2] === 0x03 && content[3] === 0x04;
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(input.content as unknown as ArrayBuffer);
    } catch (error) {
      throw new LocaleHubError(
        ErrorCode.UNSUPPORTED_FORMAT,
        input.filePath + ' is not a readable .xlsx workbook: ' + (error instanceof Error ? error.message : String(error)),
        422,
      );
    }

    const sheet = workbook.worksheets[0];
    if (!sheet) throw new LocaleHubError(ErrorCode.UNSUPPORTED_FORMAT, input.filePath + ' contains no worksheet', 422);
    if (sheet.rowCount > MAX_ROWS) {
      throw new LocaleHubError(
        ErrorCode.UNSUPPORTED_FORMAT,
        input.filePath + ' has ' + sheet.rowCount + ' rows, above the ' + MAX_ROWS + ' row limit',
        422,
      );
    }

    const cells: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = [];
      // `row.values` is 1-based with a hole at index 0; cellValues can be rich text or formulae,
      // so each is reduced to the text a person would see.
      const raw = row.values as unknown[];
      for (let index = 1; index < raw.length; index += 1) values.push(cellText(raw[index]));
      cells.push(values);
    });

    if (!cells.length) return [];
    const header = cells[0]!.map(resolveColumn);
    if (!header.includes('key')) {
      throw new LocaleHubError(
        ErrorCode.UNSUPPORTED_FORMAT,
        input.filePath +
          ': the first row of sheet "' +
          sheet.name +
          '" must be a header containing a "key" column (got: ' +
          (cells[0]!.join(', ') || '(empty)') +
          ')',
        422,
      );
    }
    const at = (row: string[], column: string) => {
      const index = header.indexOf(column as never);
      return index === -1 ? '' : (row[index] ?? '');
    };

    const rows = cells
      .slice(1)
      .filter((row) => row.some((cell) => cell.trim() !== ''))
      .map((row) => ({
        key: at(row, 'key'),
        namespace: at(row, 'namespace'),
        locale: at(row, 'locale'),
        value: at(row, 'value'),
        description: at(row, 'description') || undefined,
      }));

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
      'xlsx',
    );
  }

  async applyPatch(): Promise<Buffer> {
    assertWholeFile('An .xlsx workbook');
  }

  async serialize(entries: NormalizedEntry[]) {
    const grouped = new Map<string, NormalizedEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.filePath) ?? [];
      list.push(entry);
      grouped.set(entry.filePath, list);
    }

    const files = [];
    for (const [filePath, list] of grouped) {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(list[0]?.locale || 'translations');
      sheet.addRow(['key', 'namespace', 'locale', 'value', 'description']);
      sheet.getRow(1).font = { bold: true };
      for (const entry of list) sheet.addRow(rowFromEntry(entry));
      sheet.columns = [
        { width: 40 },
        { width: 18 },
        { width: 10 },
        { width: 60 },
        { width: 40 },
      ];

      const buffer = await workbook.xlsx.writeBuffer();
      files.push({
        filePath,
        format: this.id,
        locale: list[0]?.locale ?? '',
        // Binary: base64 so it survives a JSON response body. The API does not yet hand out
        // pre-signed URLs (spec §8.4), so this is the delivery mechanism for now.
        content: Buffer.from(buffer).toString('base64'),
        encoding: 'base64' as const,
        mimeType: MIME,
      });
    }
    return files;
  }
}

/**
 * The text a person would read in the cell.
 *
 * ExcelJS hands back numbers, dates, rich-text runs and formula results; a translation column can
 * legitimately be any of them (a bare number is a valid string translation), so this reduces
 * rather than rejects.
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const candidate = value as { richText?: { text: string }[]; text?: string; result?: unknown; formula?: string; hyperlink?: string };
    if (candidate.richText) return candidate.richText.map((run) => run.text).join('');
    if (typeof candidate.text === 'string') return candidate.text;
    if (candidate.result !== undefined) return cellText(candidate.result);
    // A formula with no cached result: surface the formula so the import shows something truthful
    // rather than an empty translation.
    if (candidate.formula) return '=' + candidate.formula;
  }
  return String(value);
}
