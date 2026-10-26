import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import config from './capacitor.config.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('capacitor.config', () => {
  it('identifies the app', () => {
    expect(config.appId).toBe('io.github.pratyayops.fxm')
    expect(config.appName).toBe('FXM')
  })

  it('keeps the global CapacitorHttp fetch patch off', () => {
    // It drops Cookie, Origin and Referer and corrupts binary bodies; the FxmHttp plugin
    // (stage 6.2) is the app's fetch instead.
    expect(config.plugins?.CapacitorHttp?.enabled).toBe(false)
  })

  it('keeps plugin results, such as response bodies and tokens, out of the logs', () => {
    // With 'debug', debug builds log every bridge result to the console, which reaches logcat.
    expect(config.loggingBehavior).toBe('none')
    expect(config.android?.loggingBehavior).toBeUndefined()
  })

  it('wraps the web build that build:mobile makes with base /', () => {
    const web = JSON.parse(read('../web/package.json')) as { scripts: Record<string, string> }
    expect(web.scripts['build:mobile']).toBe('vite build --base=/ --outDir dist-mobile')
    expect(config.webDir).toBe('../web/dist-mobile')
  })

  it('shows the dark theme background until the page paints', () => {
    const tokens = read('../web/src/styles/tokens.css')
    const background = /--color-background:\s*(#[0-9a-f]{6})/.exec(tokens)?.[1]
    expect(background).toBeDefined()
    expect(config.backgroundColor).toBe(background)
    expect(read('android/app/src/main/res/values/colors.xml')).toContain(
      `<color name="fxm_background">${background}</color>`,
    )
  })

  it('gives the system bars light icons for the dark theme', () => {
    expect(config.plugins?.SystemBars).toMatchObject({ insetsHandling: 'native', style: 'DARK' })
  })
})
