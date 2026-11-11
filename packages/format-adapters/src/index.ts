import type { FileFormatId, FormatAdapter } from '@localehub/contracts';
import { ErrorCode, LocaleHubError } from '@localehub/contracts';
import { JsonAdapter } from './json-adapter';
import { YamlAdapter } from './adapters/yaml';
import { AppleStringsAdapter } from './adapters/ios-strings';
import { StringsdictAdapter } from './adapters/stringsdict';
import { XcstringsAdapter } from './adapters/xcstrings';
import { AndroidXmlAdapter } from './adapters/android-xml';
import { PoAdapter } from './adapters/po';
import { XliffAdapter } from './adapters/xliff';
import { CsvAdapter } from './adapters/csv';
import { XlsxAdapter } from './adapters/xlsx';

export * from './json-scan';
export * from './json-patch-utils';
export * from './text-utils';
export * from './icu';
export * from './json-adapter';
export * from './adapters/yaml';
export * from './adapters/ios-strings';
export * from './adapters/stringsdict';
export * from './adapters/xcstrings';
export * from './adapters/android-xml';
export * from './adapters/po';
export * from './adapters/xliff';
export * from './adapters/tabular';
export * from './adapters/csv';
export * from './adapters/xlsx';

const REGISTRY: Record<FileFormatId, () => FormatAdapter> = {
  json: () => new JsonAdapter(),
  yaml: () => new YamlAdapter(),
  po: () => new PoAdapter(),
  xliff: () => new XliffAdapter(),
  'ios-strings': () => new AppleStringsAdapter(),
  'ios-stringsdict': () => new StringsdictAdapter(),
  xcstrings: () => new XcstringsAdapter(),
  'android-xml': () => new AndroidXmlAdapter(),
  csv: () => new CsvAdapter(),
  xlsx: () => new XlsxAdapter(),
};

export function createAdapter(format: FileFormatId, options: { keyMode?: 'nested' | 'flat'; namespaceFromPath?: boolean } = {}): FormatAdapter {
  if (format === 'json') return new JsonAdapter(options);
  const factory = REGISTRY[format];
  if (!factory) {
    throw new LocaleHubError(ErrorCode.UNSUPPORTED_FORMAT, `No adapter registered for format "${format}"`, 422);
  }
  return factory();
}

export function supportedFormats(): FileFormatId[] {
  return Object.keys(REGISTRY) as FileFormatId[];
}

export function formatForExtension(filePath: string): FileFormatId | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.xcstrings')) return 'xcstrings';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.stringsdict')) return 'ios-stringsdict';
  if (lower.endsWith('.strings')) return 'ios-strings';
  if (lower.endsWith('.xlf') || lower.endsWith('.xliff')) return 'xliff';
  if (lower.endsWith('.po') || lower.endsWith('.pot')) return 'po';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) return 'json';
  if (lower.endsWith('.xml')) return 'android-xml';
  return null;
}
