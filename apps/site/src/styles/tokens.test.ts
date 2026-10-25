import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { THEME_COLOR } from '../config'

/*
 * WCAG AA contrast for both themes, read straight from tokens.css: 4.5:1 for text and
 * 3:1 for focus rings and control outlines. Tints mixed from the accent are blended over
 * the surface they sit on, the way the browser draws them.
 */

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

type Theme = 'dark' | 'light'
type Rgb = readonly [number, number, number]

function block(source: string, start: number): string {
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++
    if (source[index] === '}' && --depth === 0) return source.slice(open + 1, index)
  }
  throw new Error('unbalanced braces in tokens.css')
}

function tokens(theme: Theme): Map<string, string> {
  const light = css.indexOf('@media (prefers-color-scheme: light)')
  const source =
    theme === 'dark' ? block(css, css.search(/^:root\s*\{/m)) : block(block(css, light), 0)
  const values = new Map<string, string>()
  for (const match of source.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    if (match[1] && match[2]) values.set(match[1], match[2].trim())
  }
  return values
}

const THEMES: Record<Theme, Map<string, string>> = { dark: tokens('dark'), light: tokens('light') }

function hex(theme: Theme, name: string): Rgb {
  const value = THEMES[theme].get(`--color-${name}`) ?? ''
  const match = /^#([0-9a-f]{6})$/i.exec(value)
  if (!match?.[1])
    throw new Error(`--color-${name} in the ${theme} theme is not a 6-digit hex: "${value}"`)
  const digits = match[1]
  return [0, 2, 4].map((index) =>
    Number.parseInt(digits.slice(index, index + 2), 16),
  ) as unknown as Rgb
}

/** A tint such as --color-accent-soft drawn over a base colour. */
function tint(theme: Theme, name: string, base: Rgb): Rgb {
  const value = THEMES[theme].get(`--color-${name}`) ?? ''
  const match = /color-mix\(in srgb, var\(--color-([\w-]+)\) (\d+)%, transparent\)/.exec(value)
  if (!match?.[1] || !match[2])
    throw new Error(`--color-${name} is not a color-mix tint: "${value}"`)
  const color = hex(theme, match[1])
  const weight = Number(match[2]) / 100
  return color.map(
    (channel, index) => channel * weight + (base[index] ?? 0) * (1 - weight),
  ) as unknown as Rgb
}

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

describe.each<Theme>(['dark', 'light'])('%s theme', (theme) => {
  const color = (name: string) => hex(theme, name)
  const surfaces = ['background', 'surface', 'elevated'] as const

  it.each(surfaces)('text and muted text are readable on %s', (surface) => {
    expect(contrast(color('text'), color(surface))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('text-muted'), color(surface))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(surfaces)('accent text (links, labels) is readable on %s', (surface) => {
    expect(contrast(color('accent'), color(surface))).toBeGreaterThanOrEqual(4.5)
  })

  it('button text is readable on the accent, also on hover', () => {
    expect(contrast(color('on-accent'), color('accent'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('on-accent'), color('accent-hover'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['background', 'surface'] as const)(
    'badges and tinted panels on %s stay readable',
    (surface) => {
      const soft = tint(theme, 'accent-soft', color(surface))
      expect(contrast(color('text'), soft)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('text-muted'), soft)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('accent'), soft)).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(['background', 'surface'] as const)(
    'focus rings and control outlines stand out on %s',
    (surface) => {
      expect(contrast(color('focus'), color(surface))).toBeGreaterThanOrEqual(3)
      expect(contrast(color('border-strong'), color(surface))).toBeGreaterThanOrEqual(3)
    },
  )

  it('<meta name="theme-color"> matches the page background', () => {
    expect(THEMES[theme].get('--color-background')).toBe(THEME_COLOR[theme])
  })
})
