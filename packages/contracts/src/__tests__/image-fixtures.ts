/**
 * Image fixtures for the mockup tests, built here rather than checked in.
 *
 * A checked-in PNG is a file that quietly stops being a PNG — copied over, re-encoded by an editor,
 * truncated by a bad merge — and a test that reads its own fixture would keep passing. These are
 * generated from the format's own specification, so the only way they change is if someone edits the
 * bytes on purpose.
 */

/** A PNG: 8-byte signature, then an IHDR chunk carrying the dimensions. */
export function png(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // chunk length
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // colour type: RGBA
  // The CRC is not verified by the reader under test; zeros keep the fixture simple, and the test
  // that matters reads the dimensions above rather than the checksum.
  return Buffer.concat([signature, ihdr]);
}

/**
 * A JPEG: SOI, an optional APP0, then a start-of-frame carrying the dimensions.
 *
 * The APP0 is not decoration — a real JPEG always has some segment here, and a reader that assumes
 * the frame starts straight after SOI passes against a bare fixture and fails on every real file.
 */
export function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** A JPEG with the APP0 stripped, for the test that pins the segment walk itself. */
export function jpegBare(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}
