import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * Publish a release as a real file bundle.
 *
 * The snapshots were already in the database with a checksum, but "publish" ended at the row —
 * nothing could be handed to a consumer. This turns a release into a deterministic zip: the same
 * snapshots always produce the same bytes, so the recorded checksum can be re-verified by anyone
 * who downloads it.
 *
 * Written by hand rather than with a dependency because the shape needed is small and the
 * constraints are specific: stored (uncompressed) entries, fixed timestamps, sorted names. A
 * general zip library would fight all three.
 */

export interface BundleFile {
  /** Path inside the archive, e.g. `ja-JP/common.json`. */
  path: string;
  content: string;
}

export interface BundleOptions {
  releaseName: string;
  locales: string[];
  generatedAt?: Date;
  /** What produced the bundle, recorded in the manifest for traceability. */
  source?: { releaseId: string; projectId: string; checksum?: string | null };
}

interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Deterministic zip.
 *
 * - entries are sorted by name, so the archive does not depend on directory iteration order;
 * - timestamps are fixed (1980-01-01, the earliest a zip can express), so the bytes do not change
 *   between two runs of the same release;
 * - entries are stored rather than deflated: a release bundle is small and already mostly UTF-8
 *   text, and stored entries keep this implementation to one moving part.
 */
export function buildZip(files: BundleFile[]): Buffer {
  const entries: ZipEntry[] = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      const data = Buffer.from(file.content, 'utf8');
      return { name: file.path, data, crc: crc32(data) };
    });

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 name flag
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // fixed time
    local.writeUInt16LE(0x0021, 12); // fixed date: 1980-01-01
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

/** Read one entry back out of a stored-method zip. Used by the tests and by `verifyBundle`. */
export function readZipEntries(archive: Buffer): { name: string; data: Buffer }[] {
  const entries: { name: string; data: Buffer }[] = [];
  let cursor = 0;
  while (cursor + 30 <= archive.length && archive.readUInt32LE(cursor) === 0x04034b50) {
    const method = archive.readUInt16LE(cursor + 8);
    const crc = archive.readUInt32LE(cursor + 14);
    const compressedSize = archive.readUInt32LE(cursor + 18);
    const nameLength = archive.readUInt16LE(cursor + 26);
    const extraLength = archive.readUInt16LE(cursor + 28);
    const nameStart = cursor + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${archive.subarray(nameStart, nameStart + nameLength).toString('utf8')}`);
    entries.push({ name: archive.subarray(nameStart, nameStart + nameLength).toString('utf8'), data });
    cursor = dataStart + compressedSize;
  }
  return entries;
}

/** A stable digest of the bundle contents, recorded on the release row. */
export function bundleChecksum(files: BundleFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(file.path);
    hash.update('\u0000');
    hash.update(file.content);
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

/**
 * Turn release snapshots into bundle files, one JSON file per locale.
 *
 * JSON is the format every consumer can read without a lobby; a release bundle is a handoff, not
 * a sync artifact, so it does not try to reproduce the repository's file layout.
 */
export function snapshotFiles(
  snapshots: { localeCode: string; namespace: string; translationKey: string; value: string }[],
): BundleFile[] {
  const byLocale = new Map<string, Record<string, string>>();
  for (const snapshot of snapshots) {
    const locale = byLocale.get(snapshot.localeCode) ?? {};
    // Namespaced keys are flattened with a dot so one locale stays one file; the namespace is
    // already part of the key's identity in the platform.
    const key = snapshot.namespace ? `${snapshot.namespace}.${snapshot.translationKey}` : snapshot.translationKey;
    locale[key] = snapshot.value;
    byLocale.set(snapshot.localeCode, locale);
  }

  return [...byLocale.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([locale, values]) => ({
      path: `${locale}/common.json`,
      content: `${JSON.stringify(values, Object.keys(values).sort(), 2)}\n`,
    }));
}

/** A bundle is self-describing: the manifest says what produced it and what is inside. */
export function manifestFile(options: BundleOptions, files: BundleFile[]): BundleFile {
  const manifest = {
    release: options.releaseName,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    locales: options.locales,
    ...(options.source ? { source: options.source } : {}),
    files: files.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      sha256: createHash('sha256').update(file.content).digest('hex'),
    })),
    checksum: bundleChecksum(files),
  };
  return { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` };
}

export function buildReleaseBundle(options: BundleOptions, files: BundleFile[]): Buffer {
  return buildZip([...files, manifestFile(options, files)]);
}

/* ------------------------------------------------------------- object storage */

/**
 * Where bundles are written.
 *
 * A local directory rather than S3: spec §8.4 asks for pre-signed URLs instead of Base64 in JSON,
 * and a directory keyed by organization gives the same property — the API hands out a URL, and the
 * bytes never travel through a JSON body. `LOCALEHUB_BUNDLE_DIR` points it elsewhere in a
 * deployment; swapping in S3 later means replacing this one module.
 */
export function bundleStoreDir(): string {
  return resolve(process.env.LOCALEHUB_BUNDLE_DIR ?? join(process.cwd(), '.localehub-bundles'));
}

/** Path-safe key: the release id, never the release name. */
function bundlePath(organizationId: string, releaseId: string): string {
  return join(bundleStoreDir(), organizationId, `${releaseId}.zip`);
}

export function writeBundle(organizationId: string, releaseId: string, archive: Buffer): { bytes: number } {
  const target = bundlePath(organizationId, releaseId);
  mkdirSync(join(bundleStoreDir(), organizationId), { recursive: true });
  writeFileSync(target, archive);
  return { bytes: archive.length };
}

export function readBundle(organizationId: string, releaseId: string): Buffer | null {
  const target = bundlePath(organizationId, releaseId);
  if (!existsSync(target)) return null;
  return readFileSync(target);
}

export function bundleExists(organizationId: string, releaseId: string): boolean {
  return existsSync(bundlePath(organizationId, releaseId));
}

/** List stored bundles, for an operator checking what a deployment is holding. */
export function listBundles(): { organizationId: string; releaseId: string; bytes: number }[] {
  const root = bundleStoreDir();
  if (!existsSync(root)) return [];
  const found: { organizationId: string; releaseId: string; bytes: number }[] = [];
  for (const organizationId of readdirSync(root)) {
    const dir = join(root, organizationId);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.zip')) continue;
      found.push({ organizationId, releaseId: file.slice(0, -4), bytes: statSync(join(dir, file)).size });
    }
  }
  return found;
}

export { createReadStream, relative };