import { describe, expect, it } from 'vitest';
import { LocaleHubError, MAX_MOCKUP_BYTES, MAX_MOCKUP_DIMENSION } from '@localehub/contracts';

import { assertMockupDimensions, decodeMockupImage } from '../mockups';

/**
 * Fixtures built from the formats' own specifications rather than checked in.
 *
 * A checked-in PNG is a file that quietly stops being a PNG — re-encoded by an editor, truncated by a
 * bad merge — and a test that reads its own fixture would keep passing. These live in the test that
 * uses them, so the domain package does not reach into another package's source tree.
 */
function png(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([signature, ihdr]);
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/**
 * The image gate.
 *
 * Everything here is about the moment untrusted bytes become something the platform will later serve
 * to a browser under a `content-type` this code chooses. The cases are the ones a caller could
 * actually send: a text file wearing an image mime type, an SVG that runs script, a small file that
 * would decode into a canvas no browser can paint.
 */

const base64 = (bytes: Buffer) => bytes.toString('base64');

describe('decodeMockupImage', () => {
  it('accepts a PNG and reads its size from the file rather than from the caller', () => {
    const decoded = decodeMockupImage({ imageBase64: base64(png(1200, 800)), width: 1, height: 1 });
    expect(decoded.mimeType).toBe('image/png');
    expect(decoded.width).toBe(1200);
    expect(decoded.height).toBe(800);
    expect(() => assertMockupDimensions(decoded)).not.toThrow();
  });

  it('accepts a data: URL, which is what a browser tool hands over', () => {
    const decoded = decodeMockupImage({ imageBase64: `data:image/png;base64,${base64(png(4, 4))}` });
    expect(decoded.mimeType).toBe('image/png');
  });

  it('accepts a data: URL that carries parameters, which several exporters emit', () => {
    // `data:image/svg+xml;charset=utf-8;base64,…` used to be reported as "not valid base64": the strip
    // pattern demanded `;base64,` immediately after the media type, so the charset parameter stayed in
    // the payload and the caller was told its *encoding* was wrong.
    const svg = Buffer.from('<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>');
    const decoded = decodeMockupImage({ imageBase64: `data:image/svg+xml;charset=utf-8;base64,${base64(svg)}` });
    expect(decoded.mimeType).toBe('image/svg+xml');
    expect(decoded.width).toBe(8);
  });

  it('keeps the declared mime type for the response but never trusts it for the row', () => {
    // The dangerous direction: text announced as an image. Detection has to win, or the platform
    // stores a text file and later serves it back as `image/png`.
    expect(() => decodeMockupImage({ imageBase64: base64(Buffer.from('not an image')), mimeType: 'image/png' })).toThrow(
      /Unrecognised image/,
    );
  });

  it('refuses WebP by name, because it cannot read its dimensions', () => {
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);
    expect(() => decodeMockupImage({ imageBase64: base64(webp) })).toThrow(/WebP is not accepted/);
  });

  it('refuses an SVG that could act as a script, and names the construct to remove', () => {
    const svg = Buffer.from('<svg onload="alert(1)"><rect/></svg>');
    try {
      decodeMockupImage({ imageBase64: base64(svg) });
      expect.unreachable('an SVG with an event handler must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(LocaleHubError);
      expect((error as LocaleHubError).message).toContain('事件属性');
      expect((error as LocaleHubError).details).toMatchObject({ reasons: ['事件属性（onclick 等）'] });
    }
  });

  it('accepts an SVG that only draws', () => {
    const svg = Buffer.from('<svg viewBox="0 0 375 667"><rect x="10" y="10" width="80" height="30"/><text x="12" y="28">Pay</text></svg>');
    const decoded = decodeMockupImage({ imageBase64: base64(svg) });
    expect(decoded.mimeType).toBe('image/svg+xml');
    expect(decoded.width).toBe(375);
    expect(decoded.height).toBe(667);
  });

  it('refuses a canvas too large to paint, by name', () => {
    const decoded = decodeMockupImage({ imageBase64: base64(png(MAX_MOCKUP_DIMENSION + 1, 10)) });
    try {
      assertMockupDimensions(decoded);
      expect.unreachable('an oversized canvas must be refused');
    } catch (error) {
      expect((error as LocaleHubError).message).toContain('limit is');
      // The advice matters: markers are fractions, so a smaller export does not need remarking.
      expect((error as LocaleHubError).message).toContain('markers are fractions');
    }
  });

  it('refuses an oversized payload before decoding it', () => {
    const huge = 'A'.repeat(Math.ceil((MAX_MOCKUP_BYTES * 4) / 3) + 1024);
    expect(() => decodeMockupImage({ imageBase64: huge })).toThrow(/the limit is/);
  });

  it('refuses bytes that are not base64', () => {
    expect(() => decodeMockupImage({ imageBase64: 'not base64!!' })).toThrow(/not valid base64/);
  });

  it('refuses an empty upload', () => {
    expect(() => decodeMockupImage({ imageBase64: '   ' })).toThrow(/empty/);
  });

  it('keeps the JPEG path working end to end', () => {
    const decoded = decodeMockupImage({ imageBase64: base64(jpeg(375, 812)) });
    expect(decoded.mimeType).toBe('image/jpeg');
    expect(decoded.width).toBe(375);
    expect(decoded.height).toBe(812);
  });

  it('tolerates line breaks, which some clients insert every 76 characters', () => {
    const wrapped = base64(png(6, 6)).replace(/(.{4})/g, '$1\n');
    expect(decodeMockupImage({ imageBase64: wrapped }).mimeType).toBe('image/png');
  });
});