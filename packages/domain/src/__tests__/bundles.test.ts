import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReleaseBundle,
  buildZip,
  bundleChecksum,
  bundleExists,
  manifestFile,
  readBundle,
  readZipEntries,
  snapshotFiles,
  writeBundle,
} from '../bundles';

/**
 * Release bundles.
 *
 * Two properties matter and both are tested rather than assumed: the archive is a real zip (read
 * back with an independent reader, which also verifies every CRC), and it is **deterministic** —
 * the recorded checksum is only useful if the same release produces the same bytes tomorrow.
 */

const SNAPSHOTS = [
  { localeCode: 'ja-JP', namespace: 'common', translationKey: 'checkout.title', value: 'お会計' },
  { localeCode: 'ja-JP', namespace: 'common', translationKey: 'checkout.cart', value: 'カート' },
  { localeCode: 'en-US', namespace: 'common', translationKey: 'checkout.title', value: 'Checkout' },
  { localeCode: 'ja-JP', namespace: 'checkout', translationKey: 'title', value: 'ご注文' },
];

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('snapshot files', () => {
  it('groups by locale and flattens namespaces into dotted keys', () => {
    const files = snapshotFiles(SNAPSHOTS);
    expect(files.map((file) => file.path)).toEqual(['en-US/common.json', 'ja-JP/common.json']);

    const japanese = JSON.parse(files.find((file) => file.path === 'ja-JP/common.json')!.content);
    expect(japanese).toEqual({
      'checkout.title': 'ご注文',
      'common.checkout.cart': 'カート',
      'common.checkout.title': 'お会計',
    });
  });

  it('sorts keys so two exports of the same data are byte-identical', () => {
    const a = snapshotFiles(SNAPSHOTS);
    const b = snapshotFiles([...SNAPSHOTS].reverse());
    expect(a.map((file) => file.content)).toEqual(b.map((file) => file.content));
  });
});

describe('zip', () => {
  it('produces an archive an independent reader can parse, CRC included', () => {
    const archive = buildZip([
      { path: 'b.txt', content: 'second' },
      { path: 'a.txt', content: 'first' },
    ]);
    // PK\x03\x04
    expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const entries = readZipEntries(archive);
    // Sorted by name, not insertion order — that is what makes the output deterministic.
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt']);
    expect(entries.find((entry) => entry.name === 'a.txt')!.data.toString('utf8')).toBe('first');
  });

  it('is deterministic across runs and across input order', () => {
    const files = [
      { path: 'ja-JP/common.json', content: '{"a":"1"}' },
      { path: 'en-US/common.json', content: '{"a":"2"}' },
    ];
    expect(buildZip(files).equals(buildZip([...files].reverse()))).toBe(true);
    // Fixed timestamps: two runs a moment apart must not differ.
    expect(buildZip(files).equals(buildZip(files))).toBe(true);
  });

  it('round-trips non-ASCII paths and content', () => {
    const archive = buildZip([{ path: 'zh-CN/文案.json', content: '{"结算":"お会計"}' }]);
    const [entry] = readZipEntries(archive);
    expect(entry!.name).toBe('zh-CN/文案.json');
    expect(JSON.parse(entry!.data.toString('utf8'))).toEqual({ 结算: 'お会計' });
  });
});

describe('manifest', () => {
  it('records what produced the bundle and what is inside it', () => {
    const files = snapshotFiles(SNAPSHOTS);
    const manifest = manifestFile(
      {
        releaseName: 'v1.0.0',
        locales: ['ja-JP', 'en-US'],
        generatedAt: new Date('2026-11-11T00:00:00Z'),
        source: { releaseId: 'rel_1', projectId: 'prj_1', checksum: 'abc' },
      },
      files,
    );
    expect(manifest.path).toBe('manifest.json');

    const parsed = JSON.parse(manifest.content);
    expect(parsed.release).toBe('v1.0.0');
    expect(parsed.generatedAt).toBe('2026-11-11T00:00:00.000Z');
    expect(parsed.source).toEqual({ releaseId: 'rel_1', projectId: 'prj_1', checksum: 'abc' });
    expect(parsed.files.map((file: { path: string }) => file.path)).toEqual(files.map((file) => file.path));
    // Every file listed with its own digest, so a partial download can be checked.
    expect(parsed.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.checksum).toBe(bundleChecksum(files));
  });

  it('checksum ignores order and changes with content', () => {
    const files = snapshotFiles(SNAPSHOTS);
    expect(bundleChecksum(files)).toBe(bundleChecksum([...files].reverse()));
    const changed = files.map((file, index) => (index === 0 ? { ...file, content: '{"x":"y"}' } : file));
    expect(bundleChecksum(changed)).not.toBe(bundleChecksum(files));
  });
});

describe('release bundle', () => {
  it('contains the locale files plus the manifest', () => {
    const files = snapshotFiles(SNAPSHOTS);
    const archive = buildReleaseBundle({ releaseName: 'v1', locales: ['ja-JP', 'en-US'] }, files);
    const names = readZipEntries(archive).map((entry) => entry.name);
    expect(names).toEqual(['en-US/common.json', 'ja-JP/common.json', 'manifest.json']);
  });
});

describe('object storage', () => {
  it('writes, reads back and reports existence under the bundle directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localehub-bundles-'));
    tempDirs.push(dir);
    process.env.LOCALEHUB_BUNDLE_DIR = dir;
    try {
      const archive = buildReleaseBundle({ releaseName: 'v1', locales: ['ja-JP'] }, snapshotFiles(SNAPSHOTS));
      expect(bundleExists('org_1', 'rel_1')).toBe(false);

      const written = writeBundle('org_1', 'rel_1', archive);
      expect(written.bytes).toBe(archive.length);
      expect(bundleExists('org_1', 'rel_1')).toBe(true);
      expect(readBundle('org_1', 'rel_1')!.equals(archive)).toBe(true);

      // Keyed by organization and release id — never by a name a caller supplies.
      expect(readBundle('org_2', 'rel_1')).toBeNull();
      expect(readBundle('org_1', 'rel_2')).toBeNull();
    } finally {
      delete process.env.LOCALEHUB_BUNDLE_DIR;
    }
  });
});