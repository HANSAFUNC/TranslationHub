import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { ErrorCode, LocaleHubError, globToRegExp, type PlatformName } from '@localehub/contracts';
import type { FileMappingConfig, LocalConfig } from '@localehub/contracts';

/**
 * Filesystem boundary for local write-back (spec §4.2, §10.3).
 *
 * Every path the CLI touches goes through this guard. The guard:
 *   1. resolves the path against the workspace root,
 *   2. rejects `..` traversal that leaves the root,
 *   3. resolves symlinks (when the target exists) and re-checks containment,
 *   4. applies denyRead/denyWrite and allowRead/allowWrite globs,
 *   5. for writes, requires the path to also match a configured file mapping.
 *
 * Writes are only ever allowed to language resource files, never to business source code.
 */
export class WorkspaceGuard {
  readonly root: string;
  readonly config: LocalConfig;
  private readonly allowRead: RegExp[];
  private readonly allowWrite: RegExp[];
  private readonly denyRead: RegExp[];
  private readonly denyWrite: RegExp[];

  constructor(config: LocalConfig, root?: string) {
    const configuredRoot = root ?? config.workspace.root ?? '.';
    const absolute = isAbsolute(configuredRoot) ? configuredRoot : resolve(process.cwd(), configuredRoot);
    if (!existsSync(absolute)) {
      throw new LocaleHubError(ErrorCode.WORKSPACE_NOT_FOUND, `Workspace root does not exist: ${absolute}`, 400);
    }
    if (!statSync(absolute).isDirectory()) {
      throw new LocaleHubError(ErrorCode.WORKSPACE_NOT_FOUND, `Workspace root is not a directory: ${absolute}`, 400);
    }
    this.root = realpathSync(absolute);
    this.config = config;
    this.allowRead = config.workspace.allowRead.map(globToRegExp);
    this.allowWrite = config.workspace.allowWrite.map(globToRegExp);
    this.denyRead = config.workspace.denyRead.map(globToRegExp);
    this.denyWrite = config.workspace.denyWrite.map(globToRegExp);
  }

  /** Normalise a user supplied path into a workspace relative, forward-slash path. */
  toRelative(input: string): string {
    if (typeof input !== 'string' || input.length === 0) {
      throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'Path must be a non-empty string', 400);
    }
    if (input.includes('\0')) {
      throw new LocaleHubError(ErrorCode.PATH_TRAVERSAL_REJECTED, 'Path contains a NUL byte', 400);
    }
    const normalizedInput = input.replace(/\\/g, '/');
    const absolute = isAbsolute(normalizedInput) ? normalize(normalizedInput) : resolve(this.root, normalizedInput);
    const rel = relative(this.root, absolute);
    if (rel === '') return '';
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new LocaleHubError(ErrorCode.PATH_OUTSIDE_WORKSPACE, `Path escapes the workspace root: ${input}`, 403, {
        path: input,
        root: this.root,
      });
    }
    const parts = rel.split(sep).filter(Boolean);
    if (parts.some((part) => part === '..')) {
      throw new LocaleHubError(ErrorCode.PATH_TRAVERSAL_REJECTED, `Path traversal is not allowed: ${input}`, 403, { path: input });
    }
    return parts.join('/');
  }

  /**
   * Resolve symlinks and prove the real target is still inside the workspace.
   * This blocks both `link -> /etc/passwd` and `link -> ../../outside`.
   */
  resolveRealPath(relativePath: string): string {
    const direct = join(this.root, relativePath);
    let probe = direct;
    const suffix: string[] = [];
    // Walk up until an existing ancestor is found (the file may be new).
    while (!existsSync(probe)) {
      const parent = resolve(probe, '..');
      if (parent === probe) break;
      suffix.unshift(probe.slice(parent.length + 1));
      probe = parent;
    }
    let real: string;
    try {
      real = existsSync(probe) ? realpathSync(probe) : probe;
    } catch {
      real = probe;
    }
    const realJoined = suffix.length ? join(real, ...suffix) : real;
    const rel = relative(this.root, realJoined);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new LocaleHubError(
        ErrorCode.SYMLINK_ESCAPE_REJECTED,
        `Resolved path escapes the workspace root through a symlink: ${relativePath}`,
        403,
        { path: relativePath, resolved: realJoined, root: this.root },
      );
    }
    return realJoined;
  }

  /** Assert read access for a relative path. */
  assertReadable(relativePath: string): string {
    const rel = this.toRelative(relativePath);
    if (this.matchesAny(this.denyRead, rel)) {
      throw new LocaleHubError(ErrorCode.PATH_DENIED, `Path is denied for reading: ${rel}`, 403, { path: rel });
    }
    if (this.allowRead.length && !this.matchesAny(this.allowRead, rel)) {
      throw new LocaleHubError(ErrorCode.PATH_DENIED, `Path is not in allowRead: ${rel}`, 403, { path: rel });
    }
    this.resolveRealPath(rel);
    return rel;
  }

  /**
   * Assert write access. A write must satisfy THREE conditions:
   *   - not denied by denyWrite,
   *   - matched by allowWrite,
   *   - matched by a configured `files[].paths` mapping (language resource only).
   */
  assertWritable(relativePath: string): string {
    const rel = this.toRelative(relativePath);
    if (this.matchesAny(this.denyWrite, rel)) {
      throw new LocaleHubError(ErrorCode.PATH_DENIED, `Path is denied for writing: ${rel}`, 403, { path: rel });
    }
    if (!this.allowWrite.length) {
      throw new LocaleHubError(
        ErrorCode.PATH_NOT_WRITABLE,
        'workspace.allowWrite is empty: the CLI refuses to write any file',
        403,
      );
    }
    if (!this.matchesAny(this.allowWrite, rel)) {
      throw new LocaleHubError(ErrorCode.PATH_NOT_WRITABLE, `Path is not in allowWrite: ${rel}`, 403, { path: rel });
    }
    if (!this.mapFile(rel)) {
      throw new LocaleHubError(
        ErrorCode.PATH_NOT_MAPPED,
        `Path does not match any configured file mapping: ${rel}`,
        403,
        { path: rel },
      );
    }
    this.resolveRealPath(rel);
    return rel;
  }

  /** Find the file mapping that owns a workspace relative path. */
  mapFile(relativePath: string): { mapping: FileMappingConfig; locale: string | null; namespace: string } | null {
    const rel = relativePath.replace(/\\/g, '/');
    for (const mapping of this.config.files) {
      for (const pattern of mapping.paths) {
        if (globToRegExp(pattern).test(rel)) {
          return {
            mapping,
            locale: mapping.localeFromPath ? null : mapping.locale ?? null,
            namespace: mapping.namespaceFromPath ? namespaceOf(rel, mapping.locale ?? null) : '',
          };
        }
      }
    }
    return null;
  }

  isIgnoredPath(relativePath: string): boolean {
    return this.matchesAny(this.config.ignore.paths.map(globToRegExp), relativePath.replace(/\\/g, '/'));
  }

  isIgnoredKey(key: string): boolean {
    return this.matchesAny(this.config.ignore.keys.map(globToRegExp), key);
  }

  platformForPath(relativePath: string): PlatformName | null {
    return this.mapFile(relativePath)?.mapping.platform ?? null;
  }

  /** Absolute path for a workspace relative path (already validated). */
  absolute(relativePath: string): string {
    return join(this.root, relativePath);
  }

  private matchesAny(patterns: RegExp[], value: string): boolean {
    return patterns.some((pattern) => pattern.test(value));
  }
}

function namespaceOf(relativePath: string, locale: string | null): string {
  const withoutExt = relativePath.replace(/\.[^./\\]+$/, '');
  const parts = withoutExt.split('/').filter(Boolean);
  const index = locale ? parts.findIndex((part) => part === locale) : -1;
  const tail = index >= 0 ? parts.slice(index + 1) : parts.slice(-1);
  return tail.filter((part) => part && !part.startsWith('values')).join('.');
}

/**
 * Validate a parsed `.localehub/config.yaml` (spec §4.2).
 * Returns a list of blocking problems and non blocking warnings.
 */
export interface ConfigValidationResult {
  errors: { code: string; message: string; path?: string }[];
  warnings: { code: string; message: string; path?: string }[];
}

export function validateLocalConfig(config: LocalConfig): ConfigValidationResult {
  const errors: ConfigValidationResult['errors'] = [];
  const warnings: ConfigValidationResult['warnings'] = [];

  const sourceMappings = config.files.filter((mapping) => mapping.source);
  if (sourceMappings.length === 0) {
    errors.push({
      code: 'NO_SOURCE_MAPPING',
      message: `No file mapping is marked as the source locale (${config.project.sourceLocale})`,
    });
  }
  if (sourceMappings.length > 1) {
    warnings.push({
      code: 'MULTIPLE_SOURCE_MAPPINGS',
      message: `${sourceMappings.length} file mappings are marked as source; make sure this is intentional`,
    });
  }

  for (const mapping of config.files) {
    if (!mapping.locale && !mapping.localeFromPath && mapping.locale !== '*') {
      errors.push({
        code: 'MAPPING_WITHOUT_LOCALE',
        message: `File mapping ${mapping.id} has neither locale nor localeFromPath`,
        path: mapping.id,
      });
    }
    for (const pattern of mapping.paths) {
      if (pattern.includes('..')) {
        errors.push({
          code: 'MAPPING_PATH_TRAVERSAL',
          message: `File mapping ${mapping.id} contains a traversal pattern: ${pattern}`,
          path: pattern,
        });
      }
      if (isAbsolute(pattern)) {
        errors.push({
          code: 'MAPPING_ABSOLUTE_PATH',
          message: `File mapping ${mapping.id} uses an absolute path, which is not allowed: ${pattern}`,
          path: pattern,
        });
      }
    }
    const writable = config.workspace.allowWrite.some((glob) =>
      mapping.paths.some((pattern) => globsOverlap(glob, pattern)),
    );
    if (!writable) {
      warnings.push({
        code: 'MAPPING_NOT_WRITABLE',
        message: `File mapping ${mapping.id} cannot be written: no allowWrite entry overlaps its paths`,
        path: mapping.id,
      });
    }
  }

  for (const glob of [...config.workspace.allowWrite, ...config.workspace.allowRead]) {
    if (glob.startsWith('/') || glob.includes('..')) {
      errors.push({ code: 'INVALID_GLOB', message: `Workspace glob must be relative and may not traverse: ${glob}`, path: glob });
    }
  }

  // A write allowlist that also matches source code would let the MCP rewrite business code.
  for (const glob of config.workspace.allowWrite) {
    if (/\.(ts|tsx|js|jsx|java|kt|swift|py|go|rb|cs)$/.test(glob)) {
      errors.push({
        code: 'ALLOW_WRITE_SOURCE_CODE',
        message: `allowWrite must only cover language resource files, not source code: ${glob}`,
        path: glob,
      });
    }
  }

  return { errors, warnings };
}

/** Cheap "do these two globs intersect" test used only for config warnings. */
function globsOverlap(a: string, b: string): boolean {
  const aPrefix = a.split('*')[0] ?? '';
  const bPrefix = b.split('*')[0] ?? '';
  if (aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix)) return true;
  const aDir = aPrefix.slice(0, aPrefix.lastIndexOf('/') + 1);
  const bDir = bPrefix.slice(0, bPrefix.lastIndexOf('/') + 1);
  return aDir === bDir && aDir.length > 0;
}

export * from './config';
export * from './writer';
export * from './scanner';
export * from './git';
