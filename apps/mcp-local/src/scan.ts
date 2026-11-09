import { readFileSync } from 'node:fs';
import {
  ErrorCode,
  LocaleHubError,
  type NormalizedEntry,
  type PlatformName,
  type ScanBatchPayload,
} from '@localehub/contracts';
import { scanWorkspace, type ScanResult, type WorkspaceGuard } from '@localehub/workspace';

export interface ScanSummary {
  scanId: string;
  filesScanned: number;
  entriesFound: number;
  locales: string[];
  platforms: PlatformName[];
  errors: { file?: string; code: string; message: string }[];
  warnings: { file?: string; code: string; message: string }[];
  files: {
    fileId: string;
    filePath: string;
    locale: string;
    platform: string;
    format: string;
    entryCount: number;
    parseError?: string;
  }[];
}

export interface ScanOptions {
  projectId: string;
  sourceLocale: string;
  fileSetIds?: string[];
  scanId: string;
  client: { name: string; version: string; gitBranch?: string; gitCommit?: string };
  knownLocales?: string[];
}

/**
 * Scan the workspace and convert the result into the platform's scan batch payload.
 *
 * Only normalized entries for mapped files leave the machine; there is no code path here that
 * uploads a whole repository (spec §0.3).
 */
export async function scanAndCollect(
  guard: WorkspaceGuard,
  options: ScanOptions,
): Promise<{ result: ScanResult; summary: ScanSummary; payload: ScanBatchPayload }> {
  const result = await scanWorkspace(guard, {
    projectId: options.projectId,
    sourceLocale: options.sourceLocale,
    fileSetIds: options.fileSetIds,
    knownLocales: options.knownLocales,
  });

  const summary: ScanSummary = {
    scanId: options.scanId,
    filesScanned: result.files.filter((file) => !file.parseError).length,
    entriesFound: result.entries.length,
    locales: result.locales,
    platforms: [...new Set(result.entries.map((entry) => entry.platform))],
    errors: result.errors,
    warnings: result.warnings,
    files: result.files.map((file) => ({
      fileId: file.fileId,
      filePath: file.filePath,
      locale: file.locale,
      platform: file.platform,
      format: file.format,
      entryCount: file.entryCount,
      parseError: file.parseError,
    })),
  };

  const payload: ScanBatchPayload = {
    projectId: options.projectId,
    scanId: options.scanId,
    client: options.client,
    files: result.files.map((file) => ({
      fileId: file.fileId,
      filePath: file.filePath,
      locale: file.locale,
      platform: file.platform,
      format: file.format as never,
      fileHash: file.fileHash,
      entryCount: file.entryCount,
      ...(file.parseError ? { parseError: file.parseError } : {}),
    })),
    entries: result.entries.map((entry) => toScanEntry(entry)),
  };

  return { result, summary, payload };
}

export function toScanEntry(entry: NormalizedEntry) {
  return {
    key: entry.key,
    namespace: entry.namespace ?? '',
    locale: entry.locale,
    value: entry.value,
    isSource: entry.isSource,
    contentHash: entry.contentHash,
    fileId: entry.fileId,
    filePath: entry.filePath,
    description: entry.description,
    context: entry.context,
    placeholders: entry.placeholders,
    platformMetadata: entry.platformMetadata,
  };
}

/** Read source context inside the allowlist — read only, never uploaded by default. */
export function readContext(guard: WorkspaceGuard, files: string[], maxBytes: number): { file: string; excerpt: string; truncated: boolean }[] {
  return files.map((file) => {
    const relative = guard.assertReadable(file);
    const content = readFileSync(guard.absolute(relative), 'utf8');
    const truncated = Buffer.byteLength(content, 'utf8') > maxBytes;
    return {
      file: relative,
      excerpt: truncated ? content.slice(0, maxBytes) : content,
      truncated,
    };
  });
}

export function assertScanNotStale(summary: ScanSummary, requireClean = true): void {
  if (!requireClean) return;
  const fatal = summary.errors.filter((error) => error.code !== 'DUPLICATE_KEY');
  if (fatal.length) {
    throw new LocaleHubError(
      ErrorCode.PARSE_ERROR,
      `Scan produced ${fatal.length} parse error(s); fix them before syncing: ${fatal
        .slice(0, 3)
        .map((error) => `${error.file ?? '?'}: ${error.message}`)
        .join(' | ')}`,
      422,
      { errors: fatal },
    );
  }
}
