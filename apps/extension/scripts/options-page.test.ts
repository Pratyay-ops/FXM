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

  it('has no inline styles or remote resources, which the CSP would block', () => {
    expect(html).not.toMatch(/<style\b|\sstyle=/)
    expect(html.match(/<link\b[^>]*>/g)).toEqual([
      '<link rel="icon" href="icons/icon.svg" type="image/svg+xml" />',
      '<link rel="stylesheet" href="options.css" />',
    ])
    expect(html).not.toMatch(/\ssrc="(https?:)?\/\//)
    expect(script).not.toMatch(/\.style\b|setAttribute\('style'/)
  })

  it('labels the Spotify toggles and describes them', () => {
    expect(html).toContain(
      '<label for="spotify-login">Use my Spotify login from this browser</label>',
    )
    expect(html).toContain('aria-describedby="spotify-login-help"')
    expect(html).toMatch(
      /<label for="spotify-login-localhost">\s*Also let localhost pages use my Spotify login\s*<\/label>/,
    )
    expect(html).toContain('aria-describedby="spotify-login-localhost-help"')
    expect(html).toContain('role="status"')
  })

  it("hides the development build's warning and localhost toggle until the script shows them", () => {
    expect(html).toMatch(/<p id="dev-warning" class="warning" hidden>/)
    expect(html).toMatch(/<div id="localhost-login" hidden>/)
    expect(script).toContain("byId('dev-warning', HTMLElement).hidden = !DEV_BUILD")
    expect(script).toContain("byId('localhost-login', HTMLElement).hidden = !DEV_BUILD")
  })
})
