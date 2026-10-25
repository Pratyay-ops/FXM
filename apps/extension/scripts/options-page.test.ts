import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_URL } from '../src/config.ts'

const html = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8')
const script = readFileSync(new URL('../src/options/options.ts', import.meta.url), 'utf8')

describe('options page', () => {
  it('links to the FXM web app', () => {
    expect(html).toContain(`href="${APP_URL}"`)
  })

  it('has every element the script looks up', () => {
    const ids = [...script.matchAll(/byId\('([\w-]+)'/g)].map((match) => match[1])
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(html).toContain(`id="${id}"`)
  })

  it('loads only its bundled script, as the extension CSP requires', () => {
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script src="options.js" defer>'])
    expect(html).not.toMatch(/\son[a-z]+=/)
  })

  it('labels the Spotify toggle and describes it', () => {
    expect(html).toContain(
      '<label for="spotify-login">Use my Spotify login from this browser</label>',
    )
    expect(html).toContain('aria-describedby="spotify-login-help"')
    expect(html).toContain('role="status"')
  })
})
