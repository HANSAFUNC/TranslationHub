import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocaleHubError, localConfigSchema, type LocalConfig } from '@localehub/contracts';
import { WorkspaceGuard, validateLocalConfig } from '../index';
import { SafeFileWriter } from '../writer';
import { scanWorkspace } from '../scanner';

let root: string;
let outside: string;

const baseConfig = (overrides: Record<string, unknown> = {}): LocalConfig =>
  localConfigSchema.parse({
    version: 1,
    project: { id: 'prj_demo', name: 'Demo', sourceLocale: 'en-US', platforms: ['web'] },
    localehub: { apiUrl: 'https://localehub.example.com', tokenEnv: 'LOCALEHUB_TOKEN' },
    workspace: {
      root: '.',
      allowRead: ['apps/**', 'src/**'],
      allowWrite: ['apps/web/src/locales/**'],
      denyRead: ['.env*', '**/secrets/**', 'node_modules/**'],
      denyWrite: ['.env*', '**/secrets/**'],
    },
    sync: {},
    files: [
      {
        id: 'web-en',
        platform: 'web',
        locale: 'en-US',
        format: 'json',
        source: true,
        paths: ['apps/web/src/locales/en-US/**/*.json'],
        keyMode: 'nested',
        namespaceFromPath: true,
      },
      {
        id: 'web-ja',
        platform: 'web',
        locale: 'ja-JP',
        format: 'json',
        paths: ['apps/web/src/locales/ja-JP/**/*.json'],
        keyMode: 'nested',
        namespaceFromPath: true,
      },
    ],
    ignore: { keys: ['debug.*'], paths: ['**/*.generated.*'] },
    ...overrides,
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'localehub-ws-'));
  outside = mkdtempSync(join(tmpdir(), 'localehub-outside-'));
  mkdirSync(join(root, 'apps/web/src/locales/en-US'), { recursive: true });
  mkdirSync(join(root, 'apps/web/src/locales/ja-JP'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'secrets'), { recursive: true });
  writeFileSync(join(root, 'apps/web/src/locales/en-US/common.json'), JSON.stringify({ checkout: { pay_now: 'Pay now' } }, null, 2));
  writeFileSync(join(root, 'apps/web/src/locales/ja-JP/common.json'), JSON.stringify({ checkout: { pay_now: '今すぐ支払う' } }, null, 2));
  writeFileSync(join(root, 'src/App.tsx'), 'export const App = () => null;');
  writeFileSync(join(root, 'secrets/key.txt'), 'top secret');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(outside, 'evil.json'), JSON.stringify({ evil: true }));
  // symlink pointing outside the workspace
  symlinkSync(outside, join(root, 'escape-link'), 'dir');
  // symlink pointing inside the workspace (allowed)
  symlinkSync(join(root, 'src'), join(root, 'src-link'), 'dir');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('WorkspaceGuard path safety (spec §16.1)', () => {
  it('accepts a normal relative path', () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    expect(guard.toRelative('apps/web/src/locales/en-US/common.json')).toBe('apps/web/src/locales/en-US/common.json');
  });

  it('rejects ../ traversal', () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    expect(() => guard.toRelative('../../etc/passwd')).toThrow(LocaleHubError);
    try {
      guard.toRelative('apps/../../../etc/passwd');
    } catch (error) {
      expect((error as LocaleHubError).code).toBe('PATH_OUTSIDE_WORKSPACE');
    }
  });

  it('rejects an absolute path outside the workspace', () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    expect(() => guard.toRelative('/etc/passwd')).toThrow(/escapes the workspace/);
  });

  it('rejects a NUL byte in the path', () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    expect(() => guard.toRelative('apps/x\0.json')).toThrow(/NUL/);
  });

  it('rejects reading a path that is not in allowRead', () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    expect(() => guard.assertReadable('apps/web/src/locales/en-US/common.json')).not.toThrow();
    expect(() => guard.assertReadable('package.json')).toThrow(/not in allowRead/);
  });

  it('rejects reading denied paths even inside the allowlist', () => {
    const guard = new WorkspaceGuard(baseConfig({ workspace: { ...baseConfig().workspace, allowRead: ['**'] } }), root);
    expect(() => guard.assertReadable('.env')).toThrow(/denied for reading/);
    expect(() => guard.assertReadable('secrets/key.txt')).toThrow(/denied for reading/);
  });

  it('rejects a symlink that escapes the workspace', () => {
    const guard = new WorkspaceGuard(baseConfig({ workspace: { ...baseConfig().workspace, allowRead: ['**'] } }), root);
    // The path itself is inside, but its real target is outside.
    expect(() => guard.resolveRealPath('escape-link/evil.json')).toThrow(/symlink/);
  });

  it('allows a symlink that stays inside the workspace', () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    expect(() => guard.resolveRealPath('src-link/App.tsx')).not.toThrow();
  });

  it('refuses to write source code even if allowWrite is too broad', () => {
    const config = baseConfig({
      workspace: { ...baseConfig().workspace, allowWrite: ['apps/**', 'src/**'] },
    });
    const guard = new WorkspaceGuard(config, root);
    expect(() => guard.assertWritable('src/App.tsx')).toThrow(/does not match any configured file mapping/);
  });

  it('refuses to write a file that is mapped but not in allowWrite', () => {
    const config = baseConfig({ workspace: { ...baseConfig().workspace, allowWrite: ['ios/**'] } });
    const guard = new WorkspaceGuard(config, root);
    expect(() => guard.assertWritable('apps/web/src/locales/ja-JP/common.json')).toThrow(/not in allowWrite/);
  });

  it('refuses to write when allowWrite is empty', () => {
    const config = baseConfig({ workspace: { ...baseConfig().workspace, allowWrite: [] } });
    const guard = new WorkspaceGuard(config, root);
    expect(() => guard.assertWritable('apps/web/src/locales/ja-JP/common.json')).toThrow(/allowWrite is empty/);
  });

  it('maps a file to its configured locale and namespace', () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    const mapped = guard.mapFile('apps/web/src/locales/ja-JP/common.json');
    expect(mapped?.mapping.id).toBe('web-ja');
    expect(mapped?.namespace).toBe('common');
  });
});

describe('config validation (spec §4.2)', () => {
  it('reports a missing source mapping', () => {
    const config = baseConfig();
    config.files = config.files.map((mapping) => ({ ...mapping, source: false }));
    const result = validateLocalConfig(config);
    expect(result.errors.some((e) => e.code === 'NO_SOURCE_MAPPING')).toBe(true);
  });

  it('rejects allowWrite covering source code', () => {
    const config = baseConfig({ workspace: { ...baseConfig().workspace, allowWrite: ['src/**/*.ts'] } });
    const result = validateLocalConfig(config);
    expect(result.errors.some((e) => e.code === 'ALLOW_WRITE_SOURCE_CODE')).toBe(true);
  });

  it('rejects traversal patterns in file mappings', () => {
    const config = baseConfig();
    config.files[0].paths = ['../../outside/**/*.json'];
    const result = validateLocalConfig(config);
    expect(result.errors.some((e) => e.code === 'MAPPING_PATH_TRAVERSAL')).toBe(true);
  });

  it('warns when a mapping is not writable', () => {
    const config = baseConfig({ workspace: { ...baseConfig().workspace, allowWrite: ['ios/**'] } });
    const result = validateLocalConfig(config);
    expect(result.warnings.some((w) => w.code === 'MAPPING_NOT_WRITABLE')).toBe(true);
  });
});

describe('SafeFileWriter', () => {
  it('writes atomically and creates a backup', () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    const writer = new SafeFileWriter(guard);
    const target = 'apps/web/src/locales/ja-JP/common.json';
    const before = writer.readFile(target).toString('utf8');
    const result = writer.writeFile(target, Buffer.from(JSON.stringify({ checkout: { pay_now: '今すぐお支払い' } }, null, 2)), {
      createBackup: true,
    });
    expect(result.backupPath).toBeTruthy();
    expect(writer.readFile(target).toString('utf8')).toContain('今すぐお支払い');
    // restore for the other tests
    writer.writeFile(target, Buffer.from(before), { createBackup: false });
  });

  it('rolls the file back when post-write validation fails', () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    const writer = new SafeFileWriter(guard);
    const target = 'apps/web/src/locales/ja-JP/common.json';
    const before = writer.readFile(target).toString('utf8');
    expect(() =>
      writer.writeFile(target, Buffer.from('{"broken":'), {
        createBackup: true,
        validate: (_path, content) => {
          JSON.parse(content); // throws
        },
      }),
    ).toThrow();
    expect(writer.readFile(target).toString('utf8')).toBe(before);
  });

  it('refuses to write outside the allowlist', () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    const writer = new SafeFileWriter(guard);
    expect(() => writer.writeFile('src/App.tsx', Buffer.from('// hacked'), { createBackup: false })).toThrow();
  });
});

describe('scanner', () => {
  it('reads only mapped files and normalises entries', async () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    const result = await scanWorkspace(guard, { projectId: 'prj_demo', sourceLocale: 'en-US' });
    expect(result.files).toHaveLength(2);
    expect(result.entries).toHaveLength(2);
    expect(result.locales.sort()).toEqual(['en-US', 'ja-JP']);
    const ja = result.entries.find((entry) => entry.locale === 'ja-JP');
    expect(ja?.key).toBe('checkout.pay_now');
    expect(ja?.namespace).toBe('common');
    expect(ja?.isSource).toBe(false);
    const en = result.entries.find((entry) => entry.locale === 'en-US');
    expect(en?.isSource).toBe(true);
  });

  it('never reads files outside the mappings', async () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    const result = await scanWorkspace(guard, { projectId: 'prj_demo', sourceLocale: 'en-US' });
    expect(result.files.every((file) => file.filePath.startsWith('apps/web/src/locales/'))).toBe(true);
  });

  it('honours the file set filter', async () => {
    const guard = new WorkspaceGuard(baseConfig(), root);
    const result = await scanWorkspace(guard, { projectId: 'prj_demo', sourceLocale: 'en-US', fileSetIds: ['web-ja'] });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].fileId).toBe('web-ja');
  });

  it('warns about localization-looking files that no mapping claims', async () => {
    const unmappedDir = join(root, 'apps/web/src/locales/ja-JP/extra');
    mkdirSync(unmappedDir, { recursive: true });
    writeFileSync(join(unmappedDir, 'notes.po'), 'msgid "a"\nmsgstr "b"\n');
    try {
      const guard = new WorkspaceGuard(baseConfig(), root);
      const result = await scanWorkspace(guard, { projectId: 'prj_demo', sourceLocale: 'en-US' });
      expect(result.warnings.some((warning) => warning.code === 'UNMAPPED_FILE')).toBe(true);
    } finally {
      rmSync(unmappedDir, { recursive: true, force: true });
    }
  });

  it('detects a duplicate key defined in two files', async () => {
    const dir = join(root, 'apps/web/src/locales/ja-JP/ns2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'apps/web/src/locales/ja-JP/ns1.json'), JSON.stringify({ checkout: { pay_now: 'A' } }));
    writeFileSync(join(dir, 'dup.json'), JSON.stringify({ checkout: { pay_now: 'B' } }));
    try {
      // without namespaceFromPath both files share namespace "" and therefore collide
      const config = baseConfig();
      config.files = config.files.map((mapping) => ({ ...mapping, namespaceFromPath: false }));
      const guard = new WorkspaceGuard(config, root);
      const result = await scanWorkspace(guard, { projectId: 'prj_demo', sourceLocale: 'en-US' });
      expect(result.errors.some((error) => error.code === 'DUPLICATE_KEY')).toBe(true);
    } finally {
      rmSync(join(root, 'apps/web/src/locales/ja-JP/ns1.json'), { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
