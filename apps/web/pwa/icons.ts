/**
 * The app icons of the installable web app, drawn from the FXM mark (the same art as
 * `LogoMark` in src/components/ui/logo.tsx and the favicon in index.html).
 *
 * `scripts/render-icons.ts` renders these SVGs into the PNGs in public/, which are committed.
 * This module imports nothing, so that script can load it with Node's type stripping.
 *
 * @module
 */

/** The five rounded bars whose tops trace an "M", on a 32 × 32 grid. */
export const MARK_BARS = [
  { x: 4.8, y: 15, height: 9 },
  { x: 9.6, y: 8, height: 16 },
  { x: 14.4, y: 13, height: 11 },
  { x: 19.2, y: 8, height: 16 },
  { x: 24, y: 15, height: 9 },
] as const

/** Width of each bar on the 32 × 32 grid. */
export const MARK_BAR_WIDTH = 3.2

/** The mark's violet gradient, from the top left to the bottom right. */
export const MARK_GRADIENT = ['#8b5cf6', '#5b21b6'] as const

/**
 * How an icon frames the mark:
 *
 * - `any`: the mark as it is, a rounded square with transparent corners.
 * - `maskable`: the gradient to every edge, with the bars shrunk into the safe zone, the
 *   centred circle of 80 % of the icon's width that every platform mask keeps.
 * - `square`: the gradient to every edge and the bars at full size, for iOS, which rounds
 *   the corners of home screen icons itself.
 */
export type IconVariant = 'any' | 'maskable' | 'square'

/** How much a maskable icon shrinks the bars, so their corners stay inside the safe zone. */
export const MASKABLE_BAR_SCALE = 0.8

/** One PNG in public/, rendered from {@link iconSvg}. */
export interface IconFile {
  /** Path in public/, which is also the path under the app's base URL. */
  readonly file: string
  /** Width and height in pixels. */
  readonly size: number
  readonly variant: IconVariant
}

/** Every icon PNG the app ships. The web app manifest lists the `any` and `maskable` ones. */
export const ICON_FILES: readonly IconFile[] = [
  { file: 'icons/icon-192.png', size: 192, variant: 'any' },
  { file: 'icons/icon-512.png', size: 512, variant: 'any' },
  { file: 'icons/maskable-192.png', size: 192, variant: 'maskable' },
  { file: 'icons/maskable-512.png', size: 512, variant: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, variant: 'square' },
]

/** The SVG source of an icon variant, on the mark's 32 × 32 grid. */
export function iconSvg(variant: IconVariant): string {
  const corner = variant === 'any' ? ' rx="8"' : ''
  const scale = variant === 'maskable' ? MASKABLE_BAR_SCALE : 1
  // The bars are centred on (16, 16), so scaling around that point keeps them centred.
  const transform =
    scale === 1 ? '' : ` transform="translate(16 16) scale(${scale}) translate(-16 -16)"`
  const bars = MARK_BARS.map(
    ({ x, y, height }) =>
      `<rect x="${x}" y="${y}" width="${MARK_BAR_WIDTH}" height="${height}" rx="${MARK_BAR_WIDTH / 2}"/>`,
  ).join('')
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    `<stop offset="0" stop-color="${MARK_GRADIENT[0]}"/>`,
    `<stop offset="1" stop-color="${MARK_GRADIENT[1]}"/>`,
    '</linearGradient></defs>',
    `<rect width="32" height="32"${corner} fill="url(#g)"/>`,
    `<g fill="#ffffff"${transform}>${bars}</g>`,
    '</svg>',
  ].join('')
}
