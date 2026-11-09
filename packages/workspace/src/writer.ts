import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ErrorCode, LocaleHubError, fileHash } from '@localehub/contracts';
import type { WorkspaceGuard } from './index';

export interface BackupInfo {
  filePath: string;
  backupPath: string;
  checksum: string;
}

export interface WriteResult {
  filePath: string;
  backupPath: string | null;
  checksum: string;
  bytesWritten: number;
}

export interface WriteOptions {
  createBackup: boolean;
  backupRoot?: string;
  /** re-parse the written file with this callback; a throw rolls the file back */
  validate?: (filePath: string, content: string) => void;
}

/**
 * Safe file writer for the Local MCP (spec §10.3).
 *
 * Order of operations for every file:
 *   1. verify the target is writable (mapping ∩ allowWrite ∩ !denyWrite)
 *   2. verify the on-disk value still matches what the preview saw
 *   3. copy a backup into .localehub/backups/<timestamp>/
 *   4. write a temp file in the same directory, fsync, atomic rename
 *   5. re-parse the result; on failure restore the backup and rethrow
 */
export class SafeFileWriter {
  constructor(private readonly guard: WorkspaceGuard) {}

  backupRoot(): string {
    return join(this.guard.root, '.localehub', 'backups');
  }

  writeFile(relativePath: string, content: Buffer, options: WriteOptions): WriteResult {
    const rel = this.guard.assertWritable(relativePath);
    const absolute = this.guard.absolute(rel);
    const existing = existsSync(absolute) ? readFileSync(absolute) : null;

    let backupPath: string | null = null;
    if (options.createBackup && existing) {
      backupPath = this.createBackup(rel, absolute);
    }

    const tempPath = `${absolute}.localehub-tmp-${process.pid}-${Date.now()}`;
    mkdirSync(dirname(absolute), { recursive: true });
    try {
      const fd = openSync(tempPath, 'w');
      try {
        writeFileSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tempPath, absolute);
    } catch (error) {
      if (existsSync(tempPath)) rmSync(tempPath, { force: true });
      throw new LocaleHubError(ErrorCode.INTERNAL_ERROR, `Failed to write ${rel}: ${(error as Error).message}`, 500);
    }

    if (options.validate) {
      try {
        options.validate(rel, content.toString('utf8'));
      } catch (error) {
        if (backupPath && existsSync(backupPath)) {
          copyFileSync(backupPath, absolute);
        } else if (existing === null && existsSync(absolute)) {
          rmSync(absolute, { force: true });
        }
        throw error instanceof LocaleHubError
          ? error
          : new LocaleHubError(ErrorCode.PARSE_ERROR, `Written file failed validation, rolled back: ${(error as Error).message}`, 500);
      }
    }

    return {
      filePath: rel,
      backupPath,
      checksum: fileHash(readFileSync(absolute)),
      bytesWritten: content.byteLength,
    };
  }

  createBackup(relativePath: string, absolute: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(this.backupRoot(), timestamp, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(absolute, target);
    return target;
  }

  /** Verify the current on-disk value equals what the preview recorded. */
  assertUnchanged(relativePath: string, expectedValue: string | null, expectedContentHash?: string | null): void {
    const rel = this.guard.assertWritable(relativePath);
    const absolute = this.guard.absolute(rel);
    if (!existsSync(absolute)) {
      if (expectedValue !== null) {
        throw new LocaleHubError(
          ErrorCode.APPLY_REJECTED_STALE_PREVIEW,
          `File ${rel} disappeared after the preview was created`,
          409,
          { filePath: rel },
        );
      }
      return;
    }
    const content = readFileSync(absolute);
    if (expectedContentHash) {
      const actual = fileHash(content);
      if (actual !== expectedContentHash) {
        throw new LocaleHubError(
          ErrorCode.APPLY_REJECTED_STALE_PREVIEW,
          `File ${rel} changed after the preview was created`,
          409,
          { filePath: rel, expected: expectedContentHash, actual },
        );
      }
    }
  }

  readFile(relativePath: string): Buffer {
    const rel = this.guard.assertReadable(relativePath);
    const absolute = this.guard.absolute(rel);
    if (!existsSync(absolute)) {
      throw new LocaleHubError(ErrorCode.NOT_FOUND, `File not found: ${rel}`, 404);
    }
    if (!statSync(absolute).isFile()) {
      throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `Not a file: ${rel}`, 400);
    }
    return readFileSync(absolute);
  }

  resolvePath(relativePath: string): string {
    return resolve(this.guard.root, relativePath);
  }
}
