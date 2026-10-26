import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RATE_LIMIT } from '../src/bridge.ts'
import { buildManifest } from '../src/manifest.ts'
import { DEFAULT_SETTINGS } from '../src/settings.ts'
import {
  AMO_CATEGORIES,
  AMO_LICENSE,
  AMO_SUMMARY_MAX,
  amoMetadata,
  EDGE_DATA_USAGE,
  EDGE_DESCRIPTION_MAX,
  EDGE_DESCRIPTION_MIN,
  EDGE_SEARCH_TERMS,
  EDGE_SINGLE_PURPOSE,
  edgeListing,
  listingText,
  PERMISSION_JUSTIFICATIONS,
  plainText,
  reviewerNotes,
  shortDescription,
} from './listing.ts'

const REPO = new URL('../../../', import.meta.url)
const summary = listingText('summary.txt')
const description = listingText('description.md')
const notes = listingText('reviewer-notes.txt')
const allText = [
  summary,
  description,
  notes,
  EDGE_SINGLE_PURPOSE,
  ...Object.values(PERMISSION_JUSTIFICATIONS),
]

describe('AMO summary', () => {
  it("fits AMO's limit and has no URLs, which AMO refuses there", () => {
    expect(summary.length).toBeGreaterThan(50)
    expect(summary.length).toBeLessThanOrEqual(AMO_SUMMARY_MAX)
    // AMO's own check (addons-server, amo/utils.py has_urls).
    expect(summary).not.toMatch(/https?:\/\/\S+/i)
    expect(summary).not.toContain('\n')
  })

  it('says what the extension is for, and that it has no analytics and no remote code', () => {
    expect(summary).toContain('FXM')
    expect(summary).toContain('No analytics, no tracking and no remote code')
  })
})

describe('store description', () => {
  it("fits Edge's length limits as plain text", () => {
    const text = plainText(description)
    expect(text.length).toBeGreaterThanOrEqual(EDGE_DESCRIPTION_MIN)
    expect(text.length).toBeLessThanOrEqual(EDGE_DESCRIPTION_MAX)
  })

  it('uses only the Markdown AMO renders: no headings and no HTML, which AMO shows as text', () => {
    expect(description).not.toMatch(/^#/m)
    expect(description).not.toMatch(/<[a-z/][^>]*>/i)
  })

  it('describes the header rules of every service plainly', () => {
    for (const service of ['YouTube', 'Spotify', 'Last.fm']) expect(description).toContain(service)
    expect(description).toContain('Origin and Referer headers')
    expect(description).toContain('removes cookies')
    expect(description).toContain('https://fxmusic.pages.dev')
  })

  it('limits the cookie claim to the rules, since the opt-in bridge does use the login', () => {
    expect(description).toContain(
      'these rules never make the web app act as your logged-in account. Only the optional ' +
        'Spotify login bridge below does that, and only after you turn it on.',
    )
    expect(description).not.toContain('so the web app never acts as your logged-in account')
  })

  it('names the server-time request that FXM Connect makes on its own, without any setting', () => {
    expect(description).toContain(
      "FXM Connect itself also fetches Spotify's public server time " +
        '(open.spotify.com/api/server-time, without cookies)',
    )
  })

  it('marks radio and the Last.fm recommendations as coming in a later version', () => {
    const texts = [...description.split('\n'), ...Object.values(PERMISSION_JUSTIFICATIONS)]
    const mentions = texts.filter((line) => /radio/i.test(line))
    expect(mentions.length).toBeGreaterThan(0)
    for (const line of mentions) expect(line).toContain('in a later FXM version')
  })

  it("describes the opt-in Spotify bridge, Spotify's terms and the account link plainly", () => {
    expect(description).toContain('Spotify login bridge (optional, off by default)')
    expect(description).toContain('Use my Spotify login from this browser')
    expect(description).toContain('never reads, stores or forwards your cookies')
    expect(description).toContain("Spotify's terms don't permit")
    expect(description).toContain('Spotify knows that the web app')
    expect(description).toContain('private windows and container tabs')
    expect(description).toContain("asks for Firefox's consent to share authentication information")
    expect(description).toContain('It never changes anything in your Spotify account.')
  })

  it("says that the bridge's token is the only personal data FXM Connect handles", () => {
    expect(description).toContain(
      'Nothing goes to FXM: no analytics, no telemetry and no FXM servers.',
    )
    expect(description).toContain(
      'The only personal data FXM Connect handles is your Spotify token, and only with the login ' +
        'bridge on',
    )
    expect(description).not.toMatch(/no data collection/i)
  })

  it('matches the code it describes', () => {
    // "off by default"
    expect(DEFAULT_SETTINGS.spotifyLogin).toBe(false)
    // "at most about ten requests a minute"
    expect(description).toContain('about ten requests a minute')
    expect(RATE_LIMIT).toEqual({ max: 10, windowMs: 60_000 })
    // The permissions it lists are the manifest's.
    const manifest = buildManifest({ browser: 'firefox', version: '1.0.0', dev: false })
    for (const permission of manifest.permissions) expect(description).toContain(permission)
  })

  it('says FXM is not affiliated with the services and links the source and privacy pages', () => {
    expect(description).toContain(
      'not affiliated with or endorsed by YouTube, Google, Spotify or Last.fm',
    )
    expect(description).toContain('https://github.com/Pratyay-ops/FXM')
    expect(description).toContain('https://fxmusic.pages.dev/privacy')
  })

  it('reads as plain text for Edge', () => {
    expect(plainText('**What it changes** and `code`')).toBe('What it changes and code')
  })
})

describe('trademark rules (docs/LEGAL.md)', () => {
  it('names services only by their real names: no "Spot…" or "YT" lookalikes', () => {
    for (const raw of allText) {
      // Host names such as open.spotify.com are addresses, not names.
      const text = raw.replace(/\S*[\w-]+\.[\w-]+\.[a-z]+\S*/gi, '')
      for (const word of text.match(/\bspot\w*/gi) ?? []) expect(word).toBe('Spotify')
      for (const word of text.match(/\byou ?tube/gi) ?? []) expect(word).toBe('YouTube')
      expect(text).not.toMatch(/\bYT\b/)
    }
  })
})

describe('notes for reviewers', () => {
  it('name the version and its release', () => {
    const text = reviewerNotes('1.2.3', 'abc1234')
    expect(text.split('\n')[0]).toBe(
      'FXM Connect 1.2.3 (FXM release v1.2.3, built from commit abc1234).',
    )
    expect(text).toContain('https://github.com/Pratyay-ops/FXM/releases/tag/v1.2.3')
    expect(text).toContain(notes)
  })

  it('give build steps that exist in the repository', () => {
    const nvmrc = readFileSync(new URL('.nvmrc', REPO), 'utf8').trim()
    expect(notes).toContain(`Node.js ${nvmrc} `)
    expect(notes).toContain('scripts/setup.sh --frozen-lockfile --filter @fxm/extension')
    expect(notes).toContain('scripts/run.sh pnpm --filter @fxm/extension build')
    for (const path of ['scripts/setup.sh', 'scripts/run.sh', 'scripts/install-pnpm.sh']) {
      expect(existsSync(new URL(path, REPO)), path).toBe(true)
    }
    const pnpm = /PNPM_VERSION=([\d.]+)/.exec(
      readFileSync(new URL('scripts/install-pnpm.sh', REPO), 'utf8'),
    )?.[1]
    expect(notes).toContain(`pnpm ${pnpm} `)
    expect(notes).toContain('apps/extension/dist/firefox/')
  })

  it('explain the data collection declaration and the bridge, as the manifest declares it', () => {
    expect(notes).toContain(
      'data_collection_permissions with required: ["none"] and optional: ["authenticationInfo"]',
    )
    const manifest = buildManifest({ browser: 'firefox', version: '1.0.0', dev: false })
    expect(manifest.browser_specific_settings?.gecko.data_collection_permissions).toEqual({
      required: ['none'],
      optional: ['authenticationInfo'],
    })
    expect(notes).toContain("credentials: 'include'")
    expect(notes).toContain('off by default')
    expect(notes).toContain('requests the optional data collection permission authenticationInfo')
    expect(EDGE_DATA_USAGE).toContain('Tick "Authentication information" and no other data type')
  })

  it('give the server-time relay its own item, as always on, apart from the opt-in bridge', () => {
    expect(notes).toContain(
      '3. Always on, without cookies: when the FXM page asks, the background relays GET ' +
        'https://open.spotify.com/api/server-time',
    )
    expect(notes).toMatch(/^4\. An optional Spotify login bridge, off by default/m)
    expect(EDGE_SINGLE_PURPOSE).toContain("relays Spotify's public server time without cookies")
  })

  it('say what the web app does with the login bridge, and how to try it', () => {
    expect(notes).toContain("The web app's Settings, Spotify account section, uses this bridge")
    expect(notes).toContain('read-only')
    expect(notes).not.toContain('changes nothing visible')
    expect(notes).toMatch(
      /^5\. Optional, with a Spotify account: sign in at https:\/\/open\.spotify\.com/m,
    )
  })

  it("test the extension with a check that the no-install mode can't pass", () => {
    expect(notes).toContain('Access-Control-Allow-Origin: https://fxmusic.pages.dev')
    expect(notes).toContain('Spotify is unreachable')
    expect(notes).not.toMatch(/succeed only with the extension/)
  })
})

describe('AMO metadata', () => {
  it('carries only the notes for reviewers on an unlisted version', () => {
    expect(amoMetadata('unlisted', '1.2.3')).toEqual({
      version: { approval_notes: reviewerNotes('1.2.3') },
    })
  })

  it('carries the listing on a listed version', () => {
    const metadata = amoMetadata('listed', '1.2.3', 'abc1234')
    expect(metadata.summary).toEqual({ 'en-US': summary })
    expect(metadata.description).toEqual({ 'en-US': description })
    expect(metadata.homepage).toEqual({ 'en-US': 'https://fxmusic.pages.dev/' })
    expect(metadata.support_url).toEqual({ 'en-US': 'https://github.com/Pratyay-ops/FXM/issues' })
    expect(metadata.requires_payment).toBe(false)
    expect(metadata.version.license).toBe(AMO_LICENSE)
    expect(metadata.version.approval_notes).toBe(reviewerNotes('1.2.3', 'abc1234'))
    expect(metadata.version.release_notes?.['en-US']).toContain('/releases/tag/v1.2.3')
  })

  it("uses AMO's slugs: the repository's license and at most three extension categories", () => {
    const license = readFileSync(new URL('LICENSE', REPO), 'utf8')
    expect(license).toContain('Apache License')
    expect(license).toContain('Version 2.0')
    expect(AMO_LICENSE).toBe('Apache-2.0')
    expect(AMO_CATEGORIES.length).toBeLessThanOrEqual(3)
    const slugs = [
      'alerts-updates',
      'appearance',
      'bookmarks',
      'download-management',
      'feeds-news-blogging',
      'games-entertainment',
      'language-support',
      'photos-music-videos',
      'privacy-security',
      'search-tools',
      'shopping',
      'social-communication',
      'tabs',
      'web-development',
      'other',
    ]
    for (const category of AMO_CATEGORIES) expect(slugs).toContain(category)
  })
})

describe('Edge listing', () => {
  it('justifies every permission and host permission of the manifest, and nothing else', () => {
    for (const browser of ['chromium', 'firefox'] as const) {
      const manifest = buildManifest({ browser, version: '1.0.0', dev: false })
      expect(Object.keys(PERMISSION_JUSTIFICATIONS).sort()).toEqual(
        [...manifest.permissions, ...manifest.host_permissions].sort(),
      )
    }
    expect(edgeListing('1.2.3')).not.toContain('(missing)')
  })

  it("keeps to Partner Center's search term limits", () => {
    expect(EDGE_SEARCH_TERMS.length).toBeLessThanOrEqual(7)
    for (const term of EDGE_SEARCH_TERMS) expect(term.length).toBeLessThanOrEqual(30)
    expect(EDGE_SEARCH_TERMS.join(' ').split(/\s+/).length).toBeLessThanOrEqual(21)
  })

  it('lists every field to paste, with the manifest description as the short description', () => {
    const listing = edgeListing('1.2.3')
    for (const field of [
      'Category: Entertainment',
      'Single purpose: ',
      'Are you using remote code? No',
      'Privacy policy URL: https://fxmusic.pages.dev/privacy#fxm-connect',
      `Short description: ${shortDescription()}`,
      'NOTES FOR CERTIFICATION',
      'FXM Connect 1.2.3',
    ]) {
      expect(listing).toContain(field)
    }
    expect(listing).toContain(plainText(description))
    expect(listing).not.toContain('**')
  })
})
