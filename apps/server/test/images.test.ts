import { describe, expect, it } from "vitest";
import { sniffImage } from "../src/domain/images.js";

/**
 * Smallest valid headers of each type, built rather than fixtured so the offset
 * every field is read from is visible in the test that asserts on it.
 */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** `segments` are inserted before the frame header, which is what the walk has
 *  to get past to find the dimensions. */
function jpeg(width: number, height: number, segments: Buffer[] = []): Buffer {
  const frame = Buffer.alloc(11);
  frame.writeUInt16BE(0xffc0, 0);
  frame.writeUInt16BE(9, 2);
  frame.writeUInt8(8, 4);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, frame]);
}

/** An APP0 JFIF block: what every real JPEG carries before its frame header. */
function jpegSegment(marker: number, payloadBytes: number): Buffer {
  const segment = Buffer.alloc(4 + payloadBytes);
  segment.writeUInt16BE(0xff00 | marker, 0);
  segment.writeUInt16BE(2 + payloadBytes, 2);
  return segment;
}

function webpLossy(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8 ", 12, "ascii");
  bytes.writeUInt16LE(width, 26);
  bytes.writeUInt16LE(height, 28);
  return bytes;
}

describe("sniffImage", () => {
  it("reads a PNG's dimensions out of its IHDR", () => {
    expect(sniffImage(png(640, 427))).toEqual({
      contentType: "image/png",
      width: 640,
      height: 427
    });
  });

  it("reads a JPEG's dimensions out of its frame header", () => {
    expect(sniffImage(jpeg(1_024, 683))).toEqual({
      contentType: "image/jpeg",
      width: 1_024,
      height: 683
    });
  });

  /* A real JPEG puts JFIF and EXIF blocks before the frame header, so the
     parse has to walk segment lengths rather than index a fixed offset. */
  it("walks past the segments a real JPEG carries first", () => {
    const withMetadata = jpeg(800, 600, [
      jpegSegment(0xe0, 14),
      jpegSegment(0xe1, 120),
      jpegSegment(0xdb, 65)
    ]);
    expect(sniffImage(withMetadata)).toMatchObject({ width: 800, height: 600 });
  });

  it("reads a lossy WebP's dimensions out of its VP8 chunk", () => {
    expect(sniffImage(webpLossy(320, 240))).toEqual({
      contentType: "image/webp",
      width: 320,
      height: 240
    });
  });

  /*
   * The point of sniffing at all. A photo API that has fallen over answers with
   * an HTML error page under whatever content type its proxy felt like, and
   * storing that would put a broken image on the profile rather than nothing.
   */
  it("rejects anything that is not one of the three types it stores", () => {
    expect(sniffImage(Buffer.from("<!DOCTYPE html><html>Not found"))).toBeNull();
    expect(sniffImage(Buffer.from(JSON.stringify({ error: "nope" })))).toBeNull();
    // A real GIF header, byte for byte: a real image, and still not one
    // of the three this stores.
    expect(
      sniffImage(
        Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00, 0x01, 0x00])
      )
    ).toBeNull();
    // An SVG is a script container and must never be served from our origin.
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });

  /* A truncated download is the common half-success, and a header that says
     nothing must not be read as a zero-by-zero image. */
  it("rejects a header that was cut off mid-parse", () => {
    expect(sniffImage(png(640, 427).subarray(0, 18))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImage(webpLossy(320, 240).subarray(0, 20))).toBeNull();
  });

  it("rejects a parse that landed on an impossible size", () => {
    expect(sniffImage(png(0, 427))).toBeNull();
    expect(sniffImage(png(640, 0))).toBeNull();
    expect(sniffImage(png(50_000, 50_000))).toBeNull();
  });
});
