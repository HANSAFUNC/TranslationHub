import { ErrorCode, LocaleHubError, type NormalizedEntry, type ValidationIssue } from '@localehub/contracts';

/**
 * Column semantics shared by the CSV and XLSX adapters.
 *
 * Both formats exist for the same job — spec §10.1: "产品经理批量编辑、导入校验". They are an
 * import/export channel for people, not a repository sync format, and that shapes every decision
 * below.
 *
 * The header is required and named, not positional. A spreadsheet loses column order the moment
 * somebody inserts one, and a parser that trusts position would then silently read translations
 * into the `key` column.
 */

export const COLUMNS = ['key', 'namespace', 'locale', 'value', 'description'] as const;
export type ColumnName = (typeof COLUMNS)[number];

/** Header aliases people actually type, mapped to the canonical name. */
const ALIASES: Record<string, ColumnName> = {
  key: 'key',
  键: 'key',
  namespace: 'namespace',
  命名空间: 'namespace',
  locale: 'locale',
  language: 'locale',
  语言: 'locale',
  value: 'value',
  translation: 'value',
  text: 'value',
  译文: 'value',
  翻译: 'value',
  description: 'description',
  comment: 'description',
  说明: 'description',
  注释: 'description',
};

export interface TabularRow {
  key: string;
  namespace: string;
  locale: string;
  value: string;
  description?: string;
}

/** Map a header cell to its canonical column, or `null` when it is unrecognised. */
export function resolveColumn(header: string): ColumnName | null {
  return ALIASES[header.trim().toLowerCase()] ?? ALIASES[header.trim()] ?? null;
}

/**
 * Validate a parsed sheet. Returns the problems instead of throwing, so an import can report
 * every bad row at once rather than one per attempt.
 */
export function validateRows(rows: TabularRow[], format: 'csv' | 'xlsx'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, number>();

  rows.forEach((row, index) => {
    const where = `row ${index + 2}`; // +2: one for the header, one for 1-based numbering
    if (!row.key.trim()) {
      issues.push({ code: 'MISSING_KEY', severity: 'ERROR', message: `${where}: key is empty`, key: row.key, locale: row.locale, filePath: '' });
      return;
    }
    if (!row.locale.trim()) {
      issues.push({ code: 'MISSING_LOCALE', severity: 'ERROR', message: `${where}: locale is empty`, key: row.key, locale: row.locale, filePath: '' });
    }
    if (row.description) {
      // Excel treats any cell starting with `=` as a formula; on import that is text, but on
      // re-export to XLSX it becomes a live formula in somebody's spreadsheet. Flagged rather
      // than silently neutralised, because the value may genuinely belong in the translation.
      if (/^[=+@]/.test(row.value) && format === 'xlsx') {
        issues.push({
          code: 'SUSPICIOUS_CELL',
          severity: 'WARNING',
          message: `${where}: value starts with "${row.value[0]}", which spreadsheet software may interpret as a formula`,
          key: row.key,
          locale: row.locale,
          filePath: '',
        });
      }
    }

    const identity = `${row.namespace}\u0004${row.key}\u0004${row.locale}`;
    const first = seen.get(identity);
    if (first !== undefined) {
      issues.push({
        code: 'DUPLICATE_KEY',
        severity: 'ERROR',
        message: `${where}: duplicate of row ${first + 2} (same key, namespace and locale)`,
        key: row.key,
        locale: row.locale,
        filePath: '',
      });
    } else {
      seen.set(identity, index);
    }
  });

  return issues;
}

/** Build the adapter's normalized entries from rows, one entry per row. */
export function rowsToEntries(
  rows: TabularRow[],
  context: { filePath: string; platform: string; defaultLocale: string; defaultNamespace: string },
): NormalizedEntry[] {
  return rows.map((row) => ({
    projectId: '',
    platform: context.platform as never,
    namespace: row.namespace || context.defaultNamespace,
    key: row.key,
    locale: row.locale || context.defaultLocale,
    value: row.value,
    isSource: false,
    ...(row.description ? { description: row.description } : {}),
    fileId: context.filePath,
    filePath: context.filePath,
    contentHash: '',
  }));
}

/** The header row every export writes, so a round trip is self-describing. */
export function headerRow(): string[] {
  return [...COLUMNS];
}

export function rowFromEntry(entry: NormalizedEntry): string[] {
  return [entry.key, entry.namespace, entry.locale, entry.value, entry.description ?? ''];
}

/** A tabular file is a whole-file format: editing one cell means rewriting the sheet. */
export function assertWholeFile(what: string): never {
  throw new LocaleHubError(
    ErrorCode.UNSUPPORTED_FORMAT,
    `${what} cannot be patched in place — spreadsheets are an import/export format, not a repository sync format. Re-export and re-import instead.`,
    422,
  );
}
