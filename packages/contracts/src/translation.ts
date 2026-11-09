/** Spec §5.1 unified translation data contract. */

export type PlatformName = 'web' | 'ios' | 'android' | 'universal';

export interface Placeholder {
  name: string;
  type?: string;
  format?: string;
}

export interface EntryContext {
  screen?: string;
  component?: string;
  filePath?: string;
  line?: number;
  screenshotUrl?: string;
  developerComment?: string;
  [key: string]: unknown;
}

export interface NormalizedEntry {
  projectId: string;
  platform: PlatformName;
  namespace: string;
  key: string;
  locale: string;
  value: string;
  isSource: boolean;
  description?: string;
  context?: EntryContext;
  placeholders?: Placeholder[];
  platformMetadata?: Record<string, unknown>;
  fileId: string;
  filePath: string;
  contentHash: string;
}

/** Entry as produced by an adapter before project/hash enrichment. */
export interface RawEntry {
  key: string;
  value: string;
  locale: string;
  namespace: string;
  platform: PlatformName;
  description?: string;
  context?: EntryContext;
  placeholders?: Placeholder[];
  platformMetadata?: Record<string, unknown>;
  filePath: string;
  line?: number;
}

export interface ValidationIssue {
  code: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  message: string;
  key?: string;
  locale?: string;
  filePath?: string;
  line?: number;
}

export interface ExportFile {
  filePath: string;
  format: string;
  content: string;
  locale: string;
}

export interface TranslationPatch {
  key: string;
  namespace: string;
  platform: PlatformName;
  locale: string;
  previousValue: string | null;
  newValue: string;
  /** for plural / variation keys: which branch to patch */
  variantPath?: string[];
}

export interface AdapterInput {
  filePath: string;
  content: Buffer;
  locale: string;
  namespace: string;
  platform: PlatformName;
  /** when true, nested JSON paths become key + namespace split by config */
  keyMode?: 'nested' | 'flat';
  namespaceFromPath?: boolean;
}

/** Spec §10.2 */
export interface FormatAdapter {
  id: string;
  extensions: string[];
  detect(filePath: string, content: Buffer): Promise<boolean>;
  parse(input: AdapterInput): Promise<RawEntry[]>;
  validate(entries: NormalizedEntry[]): Promise<ValidationIssue[]>;
  applyPatch(input: {
    originalContent: Buffer;
    changes: TranslationPatch[];
    preserveUnknownFields: boolean;
  }): Promise<Buffer>;
  serialize(entries: NormalizedEntry[]): Promise<ExportFile[]>;
}

export type FileFormatId =
  | 'json'
  | 'yaml'
  | 'po'
  | 'xliff'
  | 'ios-strings'
  | 'ios-stringsdict'
  | 'xcstrings'
  | 'android-xml';
