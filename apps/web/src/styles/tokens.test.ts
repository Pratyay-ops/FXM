import { describe, expect, it } from 'vitest'
// Vitest empties CSS imports, even `?raw`, unless the file matches `test.css.include`
// in vitest.config.ts, which lists tokens.css for this test.
import tokensCss from './tokens.css?raw'

/** Color tokens of one theme block in tokens.css, as { name: '#rrggbb' }. */
function colorTokens(section: string): Record<string, string> {
  return Object.fromEntries(
    [...section.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map(([, name, hex]) => [
      name,
      hex,
    ]),
  )
}

const darkSection = tokensCss.slice(tokensCss.indexOf('@theme'), tokensCss.indexOf('@layer base'))
const lightStart = tokensCss.search(/\[data-theme=["']light["']\]\s*\{/)
const lightSection =
  lightStart === -1 ? '' : tokensCss.slice(lightStart, tokensCss.indexOf('}', lightStart))

const themes = {
  dark: colorTokens(darkSection),
  light: { ...colorTokens(darkSection), ...colorTokens(lightSection) },
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio between two colors. */
function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (lighter + 0.05) / (darker + 0.05)
}

/** `top` at `alpha` opacity over `bottom`, blended as browsers do (`bg-danger/85`). */
function mix(top: string, bottom: string, alpha: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16)
  const blended = [1, 3, 5].map((i) =>
    Math.round(alpha * channel(top, i) + (1 - alpha) * channel(bottom, i))
      .toString(16)
      .padStart(2, '0'),
  )
  return `#${blended.join('')}`
}

// [foreground, background, minimum]: 4.5 for text, 3 for focus rings and control outlines.
const PAIRS = [
  ...['background', 'surface', 'elevated', 'elevated-hover'].flatMap((bg) => [
    ['text', bg, 4.5] as const,
    ['text-muted', bg, 4.5] as const,
  ]),
  ['accent', 'background', 4.5],
  ['accent', 'surface', 4.5],
  ['accent', 'elevated', 4.5],
  ['accent', 'elevated-hover', 3],
  ['on-accent', 'accent', 4.5],
  ['on-accent', 'accent-hover', 4.5],
  ['background', 'text', 4.5],
  ['danger', 'background', 4.5],
  ['danger', 'surface', 4.5],
  // Menu entries such as Delete, also under the hover and focus fill.
  ['danger', 'elevated', 4.5],
  ['danger', 'elevated-hover', 4.5],
  // The danger button's label.
  ['background', 'danger', 4.5],
  ['focus', 'background', 3],
  ['focus', 'surface', 3],
  ['focus', 'elevated', 3],
  ['border-strong', 'background', 3],
  ['border-strong', 'surface', 3],
] as const

describe('design tokens', () => {
  it('gives the light theme a value for every dark color token', () => {
    const themed = Object.keys(themes.dark).filter((name) => name !== 'white' && name !== 'black')
    expect(themed.length).toBeGreaterThan(10)
    expect(Object.keys(colorTokens(lightSection)).sort()).toEqual(themed.sort())
  })

  for (const [theme, colors] of Object.entries(themes)) {
    it.each(PAIRS)(`${theme}: %s on %s reaches %s:1`, (foreground, background, minimum) => {
      const fg = colors[foreground]
      const bg = colors[background]
      expect(fg, `--color-${foreground}`).toBeDefined()
      expect(bg, `--color-${background}`).toBeDefined()
      expect(contrast(fg ?? '', bg ?? '')).toBeGreaterThanOrEqual(minimum)
    })

    it(`${theme}: the danger button's label stays readable on its hover fill`, () => {
      // `hover:bg-danger/85` over the dialog's surface (button.ts).
      const hover = mix(colors.danger ?? '', colors.surface ?? '', 0.85)
      expect(contrast(colors.background ?? '', hover)).toBeGreaterThanOrEqual(4.5)
    })
  }
})

describe('themed subtrees', () => {
  it('repeat the dark defaults for an element inside a light page', () => {
    const start = tokensCss.search(/\[data-theme=["']dark["']\]\s*\{/)
    const block = start === -1 ? '' : tokensCss.slice(start, tokensCss.indexOf('}', start))
    const { white: _white, black: _black, ...defaults } = themes.dark
    expect(colorTokens(block)).toEqual(defaults)
  })
})
