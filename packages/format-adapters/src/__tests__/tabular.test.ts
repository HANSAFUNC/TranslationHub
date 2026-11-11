import { describe, expect, it } from 'vitest';
import type { AdapterInput, NormalizedEntry, TranslationPatch } from '@localehub/contracts';
import { CsvAdapter, parseCsv } from '../adapters/csv';
import { XlsxAdapter } from '../adapters/xlsx';
import { resolveColumn, validateRows } from '../adapters/tabular';
import { createAdapter, formatForExtension } from '../index';

/**
 * CSV and XLSX adapters.
 *
 * Spec §10.1 gives both the same job: "产品经理批量编辑、导入校验". They are an import/export
 * channel for people, so the tests below are mostly about the things a spreadsheet does to a file
 * between export and import — reordered columns, a BOM, CRLF, a trailing blank row — because those
 * are what actually break a round trip.
 */

function input(filePath: string, content: Buffer | string, overrides: Partial<AdapterInput> = {}): AdapterInput {
  return {
    filePath,
    content: typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
    locale: 'ja-JP',
    namespace: 'common',
    platform: 'web',
    ...overrides,
  };
}

function asNormalized(adapterId: string, filePath: string, entries: Awaited<ReturnType<CsvAdapter['parse']>>): NormalizedEntry[] {
  return entries.map((entry, index) => ({
    projectId: 'p1',
    platform: 'web',
    namespace: entry.namespace ?? 'common',
    key: entry.key,
    locale: entry.locale ?? 'ja-JP',
    value: entry.value ?? '',
    isSource: false,
    fileId: filePath,
    filePath,
    contentHash: `${adapterId}-${index}`,
  }));
}

describe('column resolution', () => {
  it('accepts the header names people actually type', () => {
    expect(resolveColumn('Key')).toBe('key');
    expect(resolveColumn('键')).toBe('key');
    expect(resolveColumn('Translation')).toBe('value');
    expect(resolveColumn('译文')).toBe('value');
    expect(resolveColumn('Language')).toBe('locale');
    expect(resolveColumn('注释')).toBe('description');
  });

  it('returns null for a column it does not know, rather than guessing', () => {
    expect(resolveColumn('screenshot')).toBeNull();
    expect(resolveColumn('')).toBeNull();
  });
});

describe('CSV parsing', () => {
  it('handles quoted fields, embedded commas, newlines and doubled quotes', () => {
    const records = parseCsv('key,value\na,"hello, world"\nb,"line1\nline2"\nc,"say ""hi"""\n');
    expect(records.map((record) => record.fields.map((field) => field.value))).toEqual([
      ['key', 'value'],
      ['a', 'hello, world'],
      ['b', 'line1\nline2'],
      ['c', 'say "hi"'],
    ]);
  });

  it('parses a file that does not end in a newline', () => {
    const records = parseCsv('key,value\na,b');
    expect(records).toHaveLength(2);
    expect(records[1]!.fields[1]!.value).toBe('b');
  });

  it('reads CRLF files, which is what Excel writes', () => {
    const records = parseCsv('key,value\r\na,b\r\n');
    expect(records.map((record) => record.fields.map((field) => field.value))).toEqual([
      ['key', 'value'],
      ['a', 'b'],
    ]);
  });

  it('reports field offsets that address the original text', () => {
    const text = 'key,value\na,b\n';
    const records = parseCsv(text);
    const field = records[1]!.fields[1]!;
    expect(text.slice(field.start, field.end)).toBe('b');
  });
});

describe('CSV round trip', () => {
  const adapter = new CsvAdapter();

  it('exports a header and one row per entry, then reads them back', async () => {
    const entries = asNormalized('csv', 'localehub/ja-JP/common.csv', [
      { key: 'checkout.title', namespace: 'common', locale: 'ja-JP', value: 'お会計' },
      { key: 'checkout.cart', namespace: 'common', locale: 'ja-JP', value: 'カート' },
    ] as never);

    const [file] = await adapter.serialize(entries);
    expect(file!.content.startsWith('﻿key,namespace,locale,value,description')).toBe(true);
    // The BOM is for Excel; the header still parses cleanly.
    const parsed = await adapter.parse(input(file!.filePath, file!.content));
    expect(parsed.map((entry) => [entry.key, entry.value])).toEqual([
      ['checkout.title', 'お会計'],
      ['checkout.cart', 'カート'],
    ]);
  });

  it('survives reordered columns, a BOM and a trailing blank row', async () => {
    // Exactly what a product manager's spreadsheet looks like after they move a column.
    const text = '﻿value,key,locale\r\nお会計,checkout.title,ja-JP\r\nカート,checkout.cart,ja-JP\r\n\r\n';
    const parsed = await adapter.parse(input('export.csv', text));
    expect(parsed.map((entry) => [entry.key, entry.value])).toEqual([
      ['checkout.title', 'お会計'],
      ['checkout.cart', 'カート'],
    ]);
  });

  it('refuses a file whose header has no key column', async () => {
    await expect(adapter.parse(input('bad.csv', 'name,text\na,b\n'))).rejects.toThrow(/must be a header containing a "key" column/);
  });

  it('patches only the changed cells and leaves the rest of the file byte-identical', async () => {
    const original = '﻿key,namespace,locale,value,description\r\ncheckout.title,common,ja-JP,old title,首屏\r\ncheckout.cart,common,ja-JP,カート,\r\n';
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [
        {
          key: 'checkout.title',
          namespace: 'common',
          platform: 'web',
          locale: 'ja-JP',
          previousValue: 'old title',
          newValue: 'お会計',
        },
      ] as TranslationPatch[],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('お会計');
    expect(text).not.toContain('old title');
    // CRLF, the BOM, the column order and the untouched row all survive.
    expect(text.startsWith('﻿key,namespace,locale,value,description\r\n')).toBe(true);
    expect(text).toContain('checkout.cart,common,ja-JP,カート,');
  });

  it('escapes a value that would otherwise break the row', async () => {
    const original = 'key,namespace,locale,value,description\ncheckout.title,common,ja-JP,old,\n';
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [
        {
          key: 'checkout.title',
          namespace: 'common',
          platform: 'web',
          locale: 'ja-JP',
          previousValue: 'old',
          newValue: 'a, b "quoted"',
        },
      ] as TranslationPatch[],
      preserveUnknownFields: true,
    });
    const text = patched.toString('utf8');
    expect(text).toContain('"a, b ""quoted"""');
    // And it reads back as the value that went in.
    const parsed = await adapter.parse(input('x.csv', text));
    expect(parsed[0]!.value).toBe('a, b "quoted"');
  });

  it('does not patch a row whose namespace or locale differs', async () => {
    // The same key in two namespaces: matching on the key alone would rewrite the wrong row.
    const original = 'key,namespace,locale,value\ntitle,common,ja-JP,keep\ntitle,checkout,ja-JP,keep\n';
    const patched = await adapter.applyPatch({
      originalContent: Buffer.from(original, 'utf8'),
      changes: [
        {
          key: 'title',
          namespace: 'checkout',
          platform: 'web',
          locale: 'ja-JP',
          previousValue: 'keep',
          newValue: 'changed',
        },
      ] as TranslationPatch[],
      preserveUnknownFields: true,
    });
    const rows = parseCsv(patched.toString('utf8')).map((record) => record.fields.map((field) => field.value));
    expect(rows[1]![3]).toBe('keep');
    expect(rows[2]![3]).toBe('changed');
  });

  it('returns the original buffer when nothing matches', async () => {
    const original = Buffer.from('key,namespace,locale,value\ntitle,common,ja-JP,x\n', 'utf8');
    const patched = await adapter.applyPatch({
      originalContent: original,
      changes: [
        { key: 'missing', namespace: 'common', platform: 'web', locale: 'ja-JP', previousValue: null, newValue: 'y' },
      ] as TranslationPatch[],
      preserveUnknownFields: true,
    });
    expect(patched.equals(original)).toBe(true);
  });
});

describe('tabular validation', () => {
  it('reports missing keys, missing locales and duplicates together', () => {
    const issues = validateRows(
      [
        { key: '', namespace: 'n', locale: 'ja-JP', value: 'x' },
        { key: 'a', namespace: 'n', locale: '', value: 'x' },
        { key: 'a', namespace: 'n', locale: 'ja-JP', value: 'x' },
        { key: 'a', namespace: 'n', locale: 'ja-JP', value: 'y' },
      ],
      'csv',
    );
    expect(issues.map((issue) => issue.code)).toEqual(['MISSING_KEY', 'MISSING_LOCALE', 'DUPLICATE_KEY']);
    // Row numbers are 1-based and account for the header, so they match the spreadsheet.
    expect(issues[0]!.message).toContain('row 2');
    expect(issues[2]!.message).toContain('row 5');
  });

  it('treats the same key in two namespaces as two rows, not a duplicate', () => {
    const issues = validateRows(
      [
        { key: 'title', namespace: 'common', locale: 'ja-JP', value: 'x' },
        { key: 'title', namespace: 'checkout', locale: 'ja-JP', value: 'y' },
      ],
      'csv',
    );
    expect(issues).toEqual([]);
  });

  it('flags a value a spreadsheet would treat as a formula', () => {
    const issues = validateRows([{ key: 'a', namespace: 'n', locale: 'ja-JP', value: '=1+1', description: 'x' }], 'xlsx');
    expect(issues.map((issue) => issue.code)).toEqual(['SUSPICIOUS_CELL']);
  });
});

describe('XLSX', () => {
  const adapter = new XlsxAdapter();

  it('exports a workbook and reads it back', async () => {
    const entries = asNormalized('xlsx', 'localehub/ja-JP/common.xlsx', [
      { key: 'checkout.title', namespace: 'common', locale: 'ja-JP', value: 'お会計' },
      { key: 'checkout.cart', namespace: 'common', locale: 'ja-JP', value: 'カート' },
    ] as never);

    const [file] = await adapter.serialize(entries);
    expect(file!.encoding).toBe('base64');
    expect(file!.mimeType).toContain('spreadsheetml');

    const parsed = await adapter.parse(input(file!.filePath, Buffer.from(file!.content, 'base64')));
    expect(parsed.map((entry) => [entry.key, entry.value])).toEqual([
      ['checkout.title', 'お会計'],
      ['checkout.cart', 'カート'],
    ]);
  });

  it('reads numbers and rich text as the text a person sees', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('t');
    sheet.addRow(['key', 'locale', 'value']);
    sheet.addRow(['a', 'ja-JP', 42]);
    sheet.addRow(['b', 'ja-JP', { richText: [{ text: 'お' }, { text: '会計' }] }]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const parsed = await adapter.parse(input('numbers.xlsx', buffer));
    expect(parsed.map((entry) => entry.value)).toEqual(['42', 'お会計']);
  });

  it('refuses to patch a workbook in place, and says why', async () => {
    // A workbook is a zip of XML parts; there is no in-place edit that preserves what the author
    // did to the file. Saying so beats silently regenerating their spreadsheet.
    await expect(adapter.applyPatch()).rejects.toThrow(/cannot be patched in place/);
  });

  it('rejects a file that is not a workbook', async () => {
    await expect(adapter.parse(input('not-really.xlsx', 'plain text'))).rejects.toThrow(/not a readable \.xlsx workbook/);
  });

  it('detects a workbook by its zip signature, not only its extension', async () => {
    const [file] = await adapter.serialize(
      asNormalized('xlsx', 'a.xlsx', [{ key: 'k', namespace: 'n', locale: 'ja-JP', value: 'v' }] as never),
    );
    expect(await adapter.detect('no-extension', Buffer.from(file!.content, 'base64'))).toBe(true);
    expect(await adapter.detect('no-extension', Buffer.from('not a zip'))).toBe(false);
  });
});

describe('registry', () => {
  it('resolves both new formats by name and by extension', () => {
    expect(createAdapter('csv').id).toBe('csv');
    expect(createAdapter('xlsx').id).toBe('xlsx');
    expect(formatForExtension('localehub/ja-JP/common.csv')).toBe('csv');
    expect(formatForExtension('localehub/ja-JP/common.xlsx')).toBe('xlsx');
  });
});
