import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_URL } from '../src/config.ts'
import { dropDevBlocks, optionsPage } from './options-page.ts'

const html = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8')
const script = readFileSync(new URL('../src/options/options.ts', import.meta.url), 'utf8')
const release = optionsPage(html, false)

/** The ids an options.ts excerpt looks up with byId(). */
const lookups = (code: string) => [...code.matchAll(/byId\('([\w-]+)'/g)].map((match) => match[1])
/** The development build's own lookups, in developmentParts(), and every other one. */
const devCode = /\nfunction developmentParts\(\)[\s\S]*?\n}\n/.exec(script)?.[0] ?? ''
const devLookups = lookups(devCode)
const releaseLookups = lookups(script.replace(devCode, ''))

describe('options page', () => {
  it('links to the FXM web app', () => {
    expect(html).toContain(`href="${APP_URL}"`)
  })

  it('has every element the script looks up', () => {
    expect(releaseLookups.length).toBeGreaterThan(0)
    for (const id of [...releaseLookups, ...devLookups]) expect(html).toContain(`id="${id}"`)
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

  it("asks for Firefox's consent before it saves the login, and explains that only in Firefox", () => {
    expect(html).toMatch(/<p id="spotify-consent-help" class="help" hidden>/)
    expect(script).toContain("byId('spotify-consent-help', HTMLElement).hidden = !consent.needed")
    expect(script.indexOf('consent.request()')).toBeGreaterThan(0)
    expect(script.indexOf('consent.request()')).toBeLessThan(script.indexOf('settings.write('))
    expect(script).toContain('consent.release()')
  })
})

describe("the development build's parts", () => {
  it('are marked data-dev and hidden until the script shows them', () => {
    expect(html).toMatch(/<span id="dev-badge" class="badge" data-dev hidden>/)
    expect(html).toMatch(/<p id="dev-warning" class="warning" data-dev hidden>/)
    expect(html).toMatch(/<div id="localhost-login" data-dev hidden>/)
    expect(script).toContain('...(DEV_BUILD ? developmentParts() : []),')
  })

  it('are all the release page lacks, and the script looks them up only in that build', () => {
    expect(devLookups.sort()).toEqual([
      'dev-badge',
      'dev-warning',
      'localhost-login',
      'spotify-login-localhost',
    ])
    for (const id of devLookups) expect(release).not.toContain(`id="${id}"`)
    for (const id of releaseLookups) expect(release).toContain(`id="${id}"`)
    expect(release).not.toContain('localhost')
    expect(optionsPage(html, true)).toBe(html)
  })

  it('go with their contents and the lines they had to themselves', () => {
    const page = [
      '<main>',
      '  <p>Kept</p>',
      '',
      '  <div id="a" data-dev hidden>',
      '    <div class="setting"><input /></div>',
      '    <p>Inner</p>',
      '  </div>',
      '',
      '  <p>Version <span id="b" data-dev>dev</span> 1</p>',
      '</main>',
      '',
    ].join('\n')
    expect(dropDevBlocks(page)).toBe(
      ['<main>', '  <p>Kept</p>', '', '  <p>Version  1</p>', '</main>', ''].join('\n'),
    )
  })

  it('must have a closing tag', () => {
    expect(() => dropDevBlocks('<p data-dev>open')).toThrow(/<p data-dev> has no closing tag/)
  })
})
