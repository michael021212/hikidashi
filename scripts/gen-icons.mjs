// public/icon-192.png と icon-512.png を生成する（外部依存なし）
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [37, 99, 235];
const FG = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 塗りつぶしの正方形に、中心がずれた2つのリング（記憶がつながるイメージ）
function pixel(x, y, size) {
  const r = size * 0.2;
  const w = size * 0.055;
  const cy = size / 2;
  for (const cx of [size * 0.4, size * 0.6]) {
    const d = Math.hypot(x - cx, y - cy);
    if (Math.abs(d - r) < w) return FG;
  }
  return BG;
}

function png(size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) row.set(pixel(x + 0.5, y + 0.5, size), 1 + x * 3);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) writeFileSync(`public/icon-${size}.png`, png(size));
