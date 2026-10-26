import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  androidResources,
  LEGACY_DENSITIES,
  MARK,
  NOTIFICATION_ICON_PATH,
  notificationIcon,
} from './icons.ts'
import { decodePng } from './png.ts'

const res = new URL('../android/app/src/main/res/', import.meta.url)
const { xml, png } = androidResources()

describe('the launcher and splash icons', () => {
  // Run `scripts/run.sh pnpm --filter @fxm/mobile icons` when these fail after editing icons.ts.
  it.each([...xml])('%s matches icons.ts', (path, text) => {
    expect(readFileSync(new URL(path, res), 'utf8')).toBe(text)
  })

  it.each([...png])('%s matches icons.ts', (path, image) => {
    const committed = decodePng(readFileSync(new URL(path, res)))
    expect([committed.width, committed.height]).toEqual([image.width, image.height])
    expect(Buffer.from(committed.rgba).equals(Buffer.from(image.rgba))).toBe(true)
  })

  it('has a legacy icon pair for every density and nothing else in the mipmap folders', () => {
    const files = readdirSync(res, { recursive: true, encoding: 'utf8' })
    const mipmaps = files.filter((file) => /^mipmap-[^/]+\/.+/.test(file)).sort()
    const expected = [...xml.keys(), ...png.keys()].filter((file) => file.startsWith('mipmap-'))
    expect(mipmaps).toEqual(expected.sort())
    expect(png.size).toBe(Object.keys(LEGACY_DENSITIES).length * 2)
    expect(files.filter((file) => /splash\.png$/.test(file))).toEqual([])
  })

  it('has the notification icon icons.ts draws, inside the status bar’s live area', () => {
    const icon = notificationIcon()
    expect(
      readFileSync(new URL(`../android/${NOTIFICATION_ICON_PATH}`, import.meta.url), 'utf8'),
    ).toBe(icon)
    expect(icon).toContain('android:viewportWidth="24"')
    const numbers = [...icon.matchAll(/M([\d.]+),([\d.]+)/g)].flatMap((match) => [
      Number(match[1]),
      Number(match[2]),
    ])
    expect(numbers).toHaveLength(MARK.bars.length * 2)
    for (const value of numbers) {
      expect(value).toBeGreaterThanOrEqual(2)
      expect(value).toBeLessThanOrEqual(22)
    }
  })

  it('draws the same mark as the web app favicon', () => {
    const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')
    const favicon = decodeURIComponent(/href="data:image\/svg\+xml,([^"]+)"/.exec(html)?.[1] ?? '')
    const { size, tileRadius, gradient, barWidth, bars } = MARK
    expect(favicon).toContain(`viewBox='0 0 ${size} ${size}'`)
    expect(favicon).toContain(`<rect width='${size}' height='${size}' rx='${tileRadius}'`)
    expect(favicon).toContain(`<stop offset='0' stop-color='${gradient[0]}'/>`)
    expect(favicon).toContain(`<stop offset='1' stop-color='${gradient[1]}'/>`)
    for (const { x, y, height } of bars) {
      expect(favicon).toContain(
        `<rect x='${x}' y='${y}' width='${barWidth}' height='${height}' rx='${barWidth / 2}'/>`,
      )
    }
  })
})
