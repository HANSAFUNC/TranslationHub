import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ErrorCode,
  LocaleHubError,
  baseLanguage,
  canonicalizeLocaleTag,
  contentHash,
  globToRegExp,
  type FileMappingConfig,
  type NormalizedEntry,
  type PlatformName,
  type RawEntry,
  type ValidationIssue,
} from '@localehub/contracts';
import { createAdapter, formatForExtension, localeFromAndroidPath, supportedFormats } from '@localehub/format-adapters';
import type { WorkspaceGuard } from './index';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  'Pods',
  'vendor',
  '.gradle',
  '.idea',
  '.vscode',
  'DerivedData',
  // LocaleHub's own artifacts (backups/patches/state) are never translation sources.
  '.localehub',
]);

export interface ScannedFile {
  fileId: string;
  filePath: string;
  locale: string;
  platform: PlatformName;
  format: string;
  fileHash: string;
  entryCount: number;
  namespace: string;
  parseError?: string;
}

export interface ScanWarning {
  file?: string;
  code: string;
  message: string;
}

export interface ScanResult {
  files: ScannedFile[];
  entries: NormalizedEntry[];
  warnings: ScanWarning[];
  errors: ScanWarning[];
  locales: string[];
  fileHashByPath: Record<string, string>;
}

export interface ScanOptions {
  projectId: string;
  sourceLocale: string;
  fileSetIds?: string[];
  /** project locales used to resolve "ja" -> "ja-JP" style directory names */
  knownLocales?: string[];
  includeUnmappedWarnings?: boolean;
}

/**
 * Walk the workspace and normalise every configured language file.
 *
 * Only files matched by `files[].paths` are parsed; everything else is invisible to the
 * platform (spec §0.3: the whole repository is never uploaded).
 */
export async function scanWorkspace(guard: WorkspaceGuard, options: ScanOptions): Promise<ScanResult> {
  const warnings: ScanWarning[] = [];
  const errors: ScanWarning[] = [];
  const files: ScannedFile[] = [];
  const entries: NormalizedEntry[] = [];
  const fileHashByPath: Record<string, string> = {};
  const knownLocales = options.knownLocales ?? collectConfigLocales(guard);

  const allFiles = walkWorkspace(guard.root);
  const mappings = guard.config.files.filter(
    (mapping) => !options.fileSetIds?.length || options.fileSetIds.includes(mapping.id),
  );
  const claimed = new Set<string>();

  for (const mapping of mappings) {
    const matchers = mapping.paths.map(globToRegExp);
    const matched = allFiles.filter((file) => matchers.some((matcher) => matcher.test(file)));
    for (const relativePath of matched) {
      if (claimed.has(relativePath)) continue;
      claimed.add(relativePath);
      if (guard.isIgnoredPath(relativePath)) continue;
      try {
        const parsed = await parseFile(guard, mapping, relativePath, options, knownLocales);
        files.push(parsed.file);
        entries.push(...parsed.entries);
        fileHashByPath[relativePath] = parsed.file.fileHash;
        warnings.push(...parsed.warnings);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ file: relativePath, code: error instanceof LocaleHubError ? error.code : ErrorCode.PARSE_ERROR, message });
        files.push({
          fileId: mapping.id,
          filePath: relativePath,
          locale: mapping.locale ?? '',
          platform: mapping.platform,
          format: mapping.format,
          fileHash: '',
          entryCount: 0,
          namespace: '',
          parseError: message,
        });
      }
    }
  }

  if (options.includeUnmappedWarnings !== false) {
    for (const file of allFiles) {
      if (claimed.has(file)) continue;
      const format = formatForExtension(file);
      if (!format) continue;
      if (guard.isIgnoredPath(file)) continue;
      if (!looksLikeLocalizationFile(file, knownLocales)) continue;
      warnings.push({
        file,
        code: 'UNMAPPED_FILE',
        message: '文件未匹配到文件映射 / file does not match any configured file mapping',
      });
    }
  }

  // duplicate key detection across the whole scan (spec §4.2)
  const seen = new Map<string, NormalizedEntry>();
  for (const entry of entries) {
    const id = [entry.platform, entry.namespace, entry.key, entry.locale].join('\u0001');
    const previous = seen.get(id);
    if (previous && previous.filePath !== entry.filePath) {
      errors.push({
        file: entry.filePath,
        code: 'DUPLICATE_KEY',
        message: `Key ${entry.key} for ${entry.locale} is defined in both ${previous.filePath} and ${entry.filePath}`,
      });
    } else if (!previous) {
      seen.set(id, entry);
    }
  }

  return {
    files,
    entries,
    warnings,
    errors,
    locales: [...new Set(entries.map((entry) => entry.locale))].sort(),
    fileHashByPath,
  };
}

interface ParsedFile {
  file: ScannedFile;
  entries: NormalizedEntry[];
  warnings: ScanWarning[];
}

async function parseFile(
  guard: WorkspaceGuard,
  mapping: FileMappingConfig,
  relativePath: string,
  options: ScanOptions,
  knownLocales: string[],
): Promise<ParsedFile> {
  const content = readFileSync(guard.absolute(relativePath));
  const locale = resolveLocale(mapping, relativePath, options, knownLocales);
  const namespace = mapping.namespaceFromPath ? namespaceFor(mapping, relativePath, locale) : '';
  const adapter = createAdapter(mapping.format, {
    keyMode: mapping.keyMode ?? 'nested',
    namespaceFromPath: mapping.namespaceFromPath ?? false,
  });

  return adapter
    .parse({
      filePath: relativePath,
      content,
      locale,
      namespace,
      platform: mapping.platform,
      keyMode: mapping.keyMode ?? 'nested',
      namespaceFromPath: mapping.namespaceFromPath ?? false,
    })
    .then((raw) => {
      const normalized: NormalizedEntry[] = raw.map((entry) => normalize(entry, options.projectId, mapping));
      return {
        file: {
          fileId: mapping.id,
          filePath: relativePath,
          locale,
          platform: mapping.platform,
          format: mapping.format,
          fileHash: contentHash(content.toString('utf8')),
          entryCount: normalized.length,
          namespace,
        },
        entries: normalized,
        warnings: [] as ScanWarning[],
      } satisfies ParsedFile;
    });
}

function normalize(entry: RawEntry, projectId: string, mapping: FileMappingConfig): NormalizedEntry {
  return {
    projectId,
    platform: mapping.platform,
    namespace: entry.namespace ?? '',
    key: entry.key,
    locale: entry.locale,
    value: entry.value,
    isSource: mapping.source === true,
    description: entry.description,
    context: entry.context,
    placeholders: entry.placeholders,
    platformMetadata: entry.platformMetadata,
    fileId: mapping.id,
    filePath: entry.filePath,
    contentHash: contentHash(entry.value),
  };
}

function resolveLocale(
  mapping: FileMappingConfig,
  relativePath: string,
  options: ScanOptions,
  knownLocales: string[],
): string {
  if (mapping.locale && mapping.locale !== '*') return canonicalizeLocaleTag(mapping.locale);
  if (mapping.localeFromPath || mapping.locale === '*') {
    const derived = deriveLocaleFromPath(relativePath, knownLocales);
    if (derived) return derived;
    if (mapping.source) return canonicalizeLocaleTag(options.sourceLocale);
    throw new LocaleHubError(
      ErrorCode.INVALID_LOCALE,
      `Cannot derive a locale from ${relativePath}; add an explicit "locale" to mapping ${mapping.id}`,
      400,
      { filePath: relativePath },
    );
  }
  return canonicalizeLocaleTag(options.sourceLocale);
}

/** Derive a locale from a path: values-ja/, ja.lproj/, locales/ja-JP/, ... */
export function deriveLocaleFromPath(relativePath: string, knownLocales: string[]): string | null {
  const android = localeFromAndroidPath(relativePath);
  const candidates = [
    android,
    /(?:^|[/\\])([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)\.lproj(?:[/\\]|$)/.exec(relativePath)?.[1] ?? null,
    ...relativePath.split(/[/\\]/).filter(Boolean),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const exact = knownLocales.find((locale) => locale.toLowerCase() === candidate.toLowerCase());
    if (exact) return canonicalizeLocaleTag(exact);
  }
  for (const candidate of candidates) {
    const base = baseLanguage(candidate);
    const byLanguage = knownLocales.find((locale) => baseLanguage(locale) === base && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(candidate));
    if (byLanguage) return canonicalizeLocaleTag(byLanguage);
  }
  if (android) return canonicalizeLocaleTag(android);
  return null;
}

function namespaceFor(mapping: FileMappingConfig, relativePath: string, locale: string): string {
  const withoutExt = relativePath.replace(/\.[^./\\]+$/, '');
  const parts = withoutExt.split(/[/\\]/).filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === locale.toLowerCase());
  const tail = index >= 0 ? parts.slice(index + 1) : parts.slice(-1);
  return tail.filter((part) => part && !part.startsWith('values')).join('.');
}

function looksLikeLocalizationFile(file: string, knownLocales: string[]): boolean {
  const lower = file.toLowerCase();
  if (knownLocales.some((locale) => lower.includes(locale.toLowerCase()))) return true;
  if (/\.(strings|stringsdict|xcstrings)$/.test(lower)) return true;
  if (/values-[a-z]{2}/.test(lower)) return true;
  if (/\.(po|pot|xliff|xlf)$/.test(lower)) return true;
  return false;
}

export function collectConfigLocales(guard: WorkspaceGuard): string[] {
  const locales = new Set<string>();
  for (const mapping of guard.config.files) {
    if (mapping.locale && mapping.locale !== '*') locales.add(canonicalizeLocaleTag(mapping.locale));
  }
  locales.add(canonicalizeLocaleTag(guard.config.project.sourceLocale));
  return [...locales];
}

/** Recursively list files, skipping VCS/build/dependency directories. */
export function walkWorkspace(root: string, maxFiles = 20000): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (out.length >= maxFiles) return;
    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (out.length >= maxFiles) return;
      if (SKIP_DIRS.has(item)) continue;
      const absolute = join(dir, item);
      let stat;
      try {
        stat = statSync(absolute);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue; // never follow symlinks while walking
      if (stat.isDirectory()) {
        visit(absolute);
      } else if (stat.isFile()) {
        out.push(relative(root, absolute).split(/[/\\]/).join('/'));
      }
    }
  };
  visit(root);
  return out;
}

export function supportedFormatList(): string[] {
  return supportedFormats();
}

export function fileExists(guard: WorkspaceGuard, relativePath: string): boolean {
  return existsSync(guard.absolute(relativePath));
}

export type { ValidationIssue };
