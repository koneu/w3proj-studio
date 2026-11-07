// PNG writer: 8-bit RGBA, no filtering. The pixels go through the platform's zlib
// (CompressionStream) when it has one, else as stored deflate blocks, which every reader takes too.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A zlib stream holding the bytes uncompressed (blocks of at most 65535). */
export function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const part = data.subarray(i * 65535, (i + 1) * 65535);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = part.length & 255; out[o++] = part.length >> 8;
    out[o++] = ~part.length & 255; out[o++] = (~part.length >> 8) & 255;
    out.set(part, o);
    o += part.length;
  }
  out.set(be32(adler32(data)), o);
  return out;
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const Stream = (globalThis as { CompressionStream?: new (format: string) => { writable: WritableStream; readable: ReadableStream<Uint8Array> } }).CompressionStream;
  if (!Stream) return zlibStored(data);
  const stream = new Stream("deflate");
  const writer = stream.writable.getWriter();
  void writer.write(data as unknown as BufferSource as never).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  out.set(be32(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  out.set(be32(crc32(out.subarray(4, 8 + data.length))), 8 + data.length);
  return out;
}

/** An RGBA image (rows top to bottom) as a PNG file. `compress: false` stores the pixels as they are. */
export async function encodePng(width: number, height: number, rgba: ArrayLike<number>, opts: { compress?: boolean } = {}): Promise<Uint8Array> {
  if (!(width > 0 && height > 0) || !Number.isInteger(width) || !Number.isInteger(height) || width > 65535 || height > 65535) throw new Error(`can't write a PNG of ${width}×${height}`);
  if (rgba.length !== width * height * 4) throw new Error(`a ${width}×${height} image needs ${width * height * 4} values, got ${rgba.length}`);
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0;
    for (let i = 0; i < width * 4; i++) raw[row + 1 + i] = rgba[y * width * 4 + i];
  }
  const ihdr = new Uint8Array([...be32(width), ...be32(height), 8, 6, 0, 0, 0]);
  const idat = opts.compress === false ? zlibStored(raw) : await zlibDeflate(raw);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
