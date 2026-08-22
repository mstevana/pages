// Generates icon-192.png and icon-512.png without any image library:
// raw RGBA buffer -> minimal PNG (zlib from node core).
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 7x9 blocky "S"
const S = [
  "1111111",
  "1100000",
  "1100000",
  "1111111",
  "0000011",
  "0000011",
  "1111111",
];

function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  // background
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, 8, 9, 14);
  // neon frame
  const m = Math.round(size * 0.07);
  for (let x = m; x < size - m; x++) for (const y of [m, m + 1, size - m - 1, size - m]) set(x, y, 255, 155, 47);
  for (let y = m; y < size - m; y++) for (const x of [m, m + 1, size - m - 1, size - m]) set(x, y, 255, 155, 47);
  // letter
  const cell = Math.floor((size * 0.6) / 7);
  const ox = Math.round((size - cell * 7) / 2);
  const oy = Math.round((size - cell * S.length) / 2);
  for (let r = 0; r < S.length; r++) {
    for (let c = 0; c < 7; c++) {
      if (S[r][c] !== "1") continue;
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        set(ox + c * cell + x, oy + r * cell + y, 255, 155, 47);
      }
    }
  }
  return png(size, size, px);
}

writeFileSync(new URL("../icon-192.png", import.meta.url), makeIcon(192));
writeFileSync(new URL("../icon-512.png", import.meta.url), makeIcon(512));
console.log("icons written");
