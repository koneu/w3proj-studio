// Renders the app icon source (1024x1024 PNG) without image dependencies.
// `npm run icon` then lets the Tauri CLI derive all platform sizes from it.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 1024;
const px = Buffer.alloc(S * S * 4);

const inRoundRect = (x, y, r) => {
  const m = 64;
  const cx = Math.min(Math.max(x, m + r), S - m - r);
  const cy = Math.min(Math.max(y, m + r), S - m - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= m && y >= m && x < S - m && y < S - m;
};

// A stylised "W" made of two chevrons, as distance-to-segment strokes.
const segs = [[230, 300, 360, 740], [360, 740, 512, 420], [512, 420, 664, 740], [664, 740, 794, 300]];
const distSeg = (x, y, [x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
};

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (!inRoundRect(x, y, 180)) continue;
    const g = y / S;
    let [r, gr, b] = [30 + 20 * g, 34 + 30 * g, 44 + 50 * g];
    const d = Math.min(...segs.map((s) => distSeg(x, y, s)));
    if (d < 58) {
      const shade = 1 - (y - 300) / 900;
      [r, gr, b] = [217 * shade + 30, 164 * shade + 20, 65 * shade];
    }
    px[i] = r; px[i + 1] = gr; px[i + 2] = b; px[i + 3] = 255;
  }
}

const crc = (buf) => {
  let c, crcVal = 0xffffffff;
  for (const byte of buf) {
    c = (crcVal ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcVal = (crcVal >>> 8) ^ c;
  }
  return (crcVal ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync("src-tauri/icons/source.png", png);
console.log("wrote src-tauri/icons/source.png");
