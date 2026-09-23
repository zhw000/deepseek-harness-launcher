// Renders the launcher icon (a rounded DeepSeek-blue tile with a white launch arrow)
// into resources/icon.png and build/icon.png. Run: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const SAMPLES = 4

function roundedRect(x, y, half, radius) {
  const qx = Math.abs(x) - half + radius
  const qy = Math.abs(y) - half + radius
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

// Signed distance to a triangle (Inigo Quilez), rounded by subtracting a radius.
function triangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const e = [[bx - ax, by - ay], [cx - bx, cy - by], [ax - cx, ay - cy]]
  const v = [[px - ax, py - ay], [px - bx, py - by], [px - cx, py - cy]]
  const s = Math.sign(e[0][0] * e[2][1] - e[0][1] * e[2][0])
  let d = Infinity
  let sign = Infinity
  for (let i = 0; i < 3; i++) {
    const [ex, ey] = e[i]
    const [vx, vy] = v[i]
    const t = Math.min(Math.max((vx * ex + vy * ey) / (ex * ex + ey * ey), 0), 1)
    const qx = vx - ex * t
    const qy = vy - ey * t
    d = Math.min(d, qx * qx + qy * qy)
    sign = Math.min(sign, s * (vx * ey - vy * ex))
  }
  return -Math.sqrt(d) * Math.sign(sign)
}

function shade(x, y) {
  const cx = x - SIZE / 2
  const cy = y - SIZE / 2
  const tile = roundedRect(cx, cy, SIZE / 2 - 8, 116)
  if (tile > 0) return [0, 0, 0, 0]
  const t = (x + y) / (2 * SIZE)
  const bg = [91 + (58 - 91) * t, 120 + (85 - 120) * t, 255 + (232 - 255) * t]
  const arrow = triangle(x, y, [206, 146], [206, 366], [388, 256]) - 26
  const cut = triangle(x, y, [206, 214], [206, 298], [276, 256]) - 6
  const white = arrow < 0 && !(cut < 0 && x > 150)
  return white ? [255, 255, 255, 255] : [...bg, 255]
}

const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const acc = [0, 0, 0, 0]
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const [r, g, b, a] = shade(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES)
        acc[0] += r * a; acc[1] += g * a; acc[2] += b * a; acc[3] += a
      }
    }
    const offset = (y * SIZE + x) * 4
    const alpha = acc[3] / (SAMPLES * SAMPLES)
    for (let c = 0; c < 3; c++) rgba[offset + c] = acc[3] === 0 ? 0 : Math.round(acc[c] / acc[3])
    rgba[offset + 3] = Math.round(alpha)
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header[8] = 8 // bit depth
header[9] = 6 // RGBA
const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) rgba.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(rows, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const target of ['resources/icon.png', 'build/icon.png']) {
  mkdirSync(dirname(join(root, target)), { recursive: true })
  writeFileSync(join(root, target), png)
}
console.log(`icon written (${png.length} bytes)`)
