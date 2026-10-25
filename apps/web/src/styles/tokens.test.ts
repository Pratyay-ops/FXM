/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Read from disk: Vitest replaces CSS imports (even `?raw`) with empty strings.
const tokensCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8')

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
const lightStart = tokensCss.search(/:root\[data-theme=["']light["']\]\s*\{/)
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
  }
})
