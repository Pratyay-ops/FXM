/**
 * The FXM mark (a violet tile with five rounded bars whose tops trace an "M", the same art as
 * the web app's logo), described once as shapes and rendered both as SVG and, at build time,
 * as anti-aliased PNGs at every icon size.
 */
import { encodePng } from './png.ts'

interface RoundedRect {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

/** Drawing units: the mark is a 32x32 square. */
const VIEWBOX = 32
const TILE: RoundedRect = { x: 0, y: 0, width: 32, height: 32, radius: 8 }
const BARS: readonly RoundedRect[] = [
  { x: 4.8, y: 15, height: 9 },
  { x: 9.6, y: 8, height: 16 },
  { x: 14.4, y: 13, height: 11 },
  { x: 19.2, y: 8, height: 16 },
  { x: 24, y: 15, height: 9 },
].map((bar) => ({ ...bar, width: 3.2, radius: 1.6 }))

/** Diagonal gradient of the tile, top-left to bottom-right. */
const GRADIENT_FROM = '#8b5cf6'
const GRADIENT_TO = '#5b21b6'

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function inside(rect: RoundedRect, x: number, y: number): boolean {
  if (x < rect.x || y < rect.y || x > rect.x + rect.width || y > rect.y + rect.height) return false
  // Distance to the rectangle shrunk by the corner radius.
  const cx = Math.min(Math.max(x, rect.x + rect.radius), rect.x + rect.width - rect.radius)
  const cy = Math.min(Math.max(y, rect.y + rect.radius), rect.y + rect.height - rect.radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= rect.radius ** 2
}

/**
 * Renders the mark as straight RGBA pixels, averaging `samples` x `samples` points per pixel
 * for anti-aliasing.
 */
export function renderIcon(size: number, samples = 8): Uint8Array {
  const from = rgb(GRADIENT_FROM)
  const to = rgb(GRADIENT_TO)
  const pixels = new Uint8Array(size * size * 4)
  const scale = VIEWBOX / size
  const total = samples * samples
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) * scale
          const y = (py + (sy + 0.5) / samples) * scale
          if (!inside(TILE, x, y)) continue
          a += 1
          if (BARS.some((bar) => inside(bar, x, y))) {
            r += 255
            g += 255
            b += 255
          } else {
            const t = (x + y) / (2 * VIEWBOX)
            r += from[0] + (to[0] - from[0]) * t
            g += from[1] + (to[1] - from[1]) * t
            b += from[2] + (to[2] - from[2]) * t
          }
        }
      }
      const offset = (py * size + px) * 4
      if (a > 0) {
        pixels[offset] = Math.round(r / a)
        pixels[offset + 1] = Math.round(g / a)
        pixels[offset + 2] = Math.round(b / a)
        pixels[offset + 3] = Math.round((a / total) * 255)
      }
    }
  }
  return pixels
}

/** The mark as a PNG file of `size` x `size` pixels. */
export function iconPng(size: number): Buffer {
  return encodePng(size, size, renderIcon(size))
}

/** The mark as a standalone SVG file. */
export function iconSvg(): string {
  const rect = ({ x, y, width, height, radius }: RoundedRect, fill = '') =>
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"${fill} />`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" width="${VIEWBOX}" height="${VIEWBOX}">`,
    '  <defs>',
    '    <linearGradient id="fxm-mark" x1="0" y1="0" x2="1" y2="1">',
    `      <stop offset="0" stop-color="${GRADIENT_FROM}" />`,
    `      <stop offset="1" stop-color="${GRADIENT_TO}" />`,
    '    </linearGradient>',
    '  </defs>',
    `  ${rect(TILE, ' fill="url(#fxm-mark)"')}`,
    '  <g fill="#ffffff">',
    ...BARS.map((bar) => `    ${rect(bar)}`),
    '  </g>',
    '</svg>',
    '',
  ].join('\n')
}
