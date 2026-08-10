/**
 * What an image actually is, read from its own bytes.
 *
 * The `content-type` header is the upstream's claim about what it sent, and
 * this server is about to store those bytes and serve them back from its own
 * origin under a type of its choosing. A response labelled `image/jpeg` that
 * holds an HTML error page is the ordinary failure mode of a misconfigured
 * photo API, not an attack, and it must end up as a cache miss rather than as
 * a broken image on the profile.
 *
 * The dimensions come out of the same headers because the parse is already
 * there, and because knowing them lets the profile reserve the right space
 * before the image arrives instead of reflowing around it.
 */

export type ImageMeta = {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
};

/**
 * The three types the cache will store. Anything else — GIF, SVG, AVIF, HTML,
 * a JSON error body — is not something this has been asked to serve, and SVG
 * in particular is a script container that has no business being handed back
 * from our own origin.
 */
export function sniffImage(bytes: Buffer): ImageMeta | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}

function readPng(bytes: Buffer): ImageMeta | null {
  // Signature, then an IHDR chunk whose width and height are the first two
  // fields of its payload. Both are at fixed offsets in a valid PNG.
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return dimensions("image/png", bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function readJpeg(bytes: Buffer): ImageMeta | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  /*
   * JPEG carries its dimensions in a start-of-frame marker, which sits after a
   * variable run of other segments, so this walks the segment lengths rather
   * than indexing. The walk is bounded by the buffer, and the buffer is bounded
   * by the download cap.
   */
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Padding between segments, and the standalone markers that carry no
    // length to skip by.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    // A segment shorter than its own length field is a malformed file, and
    // continuing would walk backwards forever.
    if (length < 2) return null;
    // SOF0 through SOF15, less the four markers in that range that are not
    // frame headers: height and width follow one byte of sample precision.
    const isFrameHeader =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrameHeader) {
      return dimensions(
        "image/jpeg",
        bytes.readUInt16BE(offset + 7),
        bytes.readUInt16BE(offset + 5)
      );
    }
    offset += 2 + length;
  }
  return null;
}

function readWebp(bytes: Buffer): ImageMeta | null {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  // Three container variants, each holding the dimensions somewhere different
  // and each storing them one short of the real value.
  const variant = bytes.toString("ascii", 12, 16);
  if (variant === "VP8 ") {
    return dimensions(
      "image/webp",
      bytes.readUInt16LE(26) & 0x3fff,
      bytes.readUInt16LE(28) & 0x3fff
    );
  }
  if (variant === "VP8L") {
    const packed = bytes.readUInt32LE(21);
    return dimensions(
      "image/webp",
      (packed & 0x3fff) + 1,
      ((packed >> 14) & 0x3fff) + 1
    );
  }
  if (variant === "VP8X") {
    return dimensions(
      "image/webp",
      bytes.readUIntLE(24, 3) + 1,
      bytes.readUIntLE(27, 3) + 1
    );
  }
  return null;
}

/** A zero or absurd dimension means the parse landed somewhere it should not. */
function dimensions(
  contentType: ImageMeta["contentType"],
  width: number,
  height: number
): ImageMeta | null {
  const sane = (value: number) =>
    Number.isInteger(value) && value > 0 && value <= 40_000;
  return sane(width) && sane(height) ? { contentType, width, height } : null;
}
