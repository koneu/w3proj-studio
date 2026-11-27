// PNG and JPEG files, decoded by the webview's own image decoder (BLP, DDS and TGA are decoded by our code in
// index.ts). Only the viewers use this: the file formats the game reads stay decodeImage's.

import type { DecodedImage, Mip } from "./index.ts";

/** Which web image format the bytes are, by their signature; null: neither. */
export function webImageKind(b: Uint8Array): "PNG" | "JPEG" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "PNG";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "JPEG";
  return null;
}

/** As much as the other decoders take (index.ts). */
const MAX_SIDE = 16384;

/** A decoded PNG or JPEG as a one-level image; throws when the webview can't decode the bytes. */
export async function decodeWebImage(bytes: Uint8Array): Promise<DecodedImage> {
  const kind = webImageKind(bytes);
  if (!kind) throw new Error("not a PNG or JPEG file");
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: kind === "PNG" ? "image/png" : "image/jpeg" }));
  try {
    const { width, height } = bitmap;
    if (width > MAX_SIDE || height > MAX_SIDE) throw new Error(`image of ${width}×${height}`);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(bitmap, 0, 0);
    const rgba = g.getImageData(0, 0, width, height).data;
    let hasAlpha = false;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { hasAlpha = true; break; }
    const mip: Mip = { width, height, rgba: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length) };
    return { format: kind, width, height, hasAlpha, mipCount: 1, mip: (level) => { if (level !== 0) throw new Error(`mip ${level} out of range`); return mip; } };
  } finally {
    bitmap.close();
  }
}
