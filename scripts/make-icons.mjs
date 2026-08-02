// Generates the app icons from a vector description — no image toolchain needed,
// just node's built-in zlib. Run `node scripts/make-icons.mjs` after changing the
// artwork below; the output lands in src-tauri/icons/ and is committed, because
// `tauri build` needs it present and CI shouldn't have to regenerate it.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');

/* ---------------------------------------------------------------- PNG ---- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ geometry ---- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const s = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const t = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const u = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return (s >= 0 && t >= 0 && u >= 0) || (s <= 0 && t <= 0 && u <= 0);
}

function inArc(x, y, cx, cy, r0, r1, halfAngleDeg) {
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d < r0 || d > r1) return false;
  // Waves open to the right, so measure against +x.
  return Math.abs(Math.atan2(dy, dx)) <= (halfAngleDeg * Math.PI) / 180;
}

/** Palette: RuneScape's dark brown chrome with the familiar gold. */
const BG = [0x24, 0x1d, 0x15];
const GOLD = [0xe8, 0xb4, 0x4a];
const GOLD_DIM = [0xb9, 0x8a, 0x34];

/**
 * Layers, back to front. Each returns coverage 0..1 for a sample point in the
 * unit square. Rendered with 4x4 supersampling, which is plenty at 16px.
 */
function sample(x, y) {
  const layers = [];

  if (inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.21)) layers.push(BG);

  // Speaker body + cone.
  const body = inRoundRect(x, y, 0.17, 0.40, 0.325, 0.60, 0.025);
  const cone =
    inTriangle(x, y, 0.325, 0.395, 0.5, 0.235, 0.325, 0.605) ||
    inTriangle(x, y, 0.5, 0.235, 0.5, 0.765, 0.325, 0.605);
  if (body || cone) layers.push(GOLD);

  // Two sound waves, the outer one dimmer so it reads as falloff.
  if (inArc(x, y, 0.5, 0.5, 0.215, 0.262, 52)) layers.push(GOLD);
  if (inArc(x, y, 0.5, 0.5, 0.312, 0.359, 52)) layers.push(GOLD_DIM);

  return layers.length ? layers[layers.length - 1] : null;
}

function render(size) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const c = sample(x, y);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            hits++;
          }
        }
      }
      const i = (py * size + px) * 4;
      const total = SS * SS;
      if (hits) {
        // Un-premultiply so edge pixels keep their colour instead of going dark.
        buf[i] = Math.round(r / hits);
        buf[i + 1] = Math.round(g / hits);
        buf[i + 2] = Math.round(b / hits);
        buf[i + 3] = Math.round(clamp01(hits / total) * 255);
      }
    }
  }
  return encodePNG(size, size, buf);
}

/* ---------------------------------------------------------------- ICO ---- */

function encodeICO(pngsBySize) {
  const entries = [...pngsBySize.entries()].sort((a, b) => a[0] - b[0]);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(([size, png], i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; // 0 means 256
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; // palette size
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...entries.map(([, png]) => png)]);
}

/* --------------------------------------------------------------- main ---- */

fs.mkdirSync(OUT, { recursive: true });

const png = new Map();
for (const size of [16, 32, 48, 64, 128, 256, 512]) png.set(size, render(size));

const write = (name, buf) => {
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`  ${name} — ${buf.length} bytes`);
};

console.log('Writing icons to src-tauri/icons/');
write('32x32.png', png.get(32));
write('128x128.png', png.get(128));
write('128x128@2x.png', png.get(256));
write('icon.png', png.get(512));
// Windows wants every size in one file; PNG-compressed entries are fine on Vista+.
write('icon.ico', encodeICO(new Map([...png].filter(([s]) => s <= 256))));
