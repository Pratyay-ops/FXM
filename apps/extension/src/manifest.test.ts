import { describe, expect, it } from 'vitest'
import { fxmOrigins } from './config.ts'
import {
  type Browser,
  buildManifest,
  FIREFOX_ADDON_ID,
  ICON_SIZES,
  isExtensionVersion,
  MAX_DESCRIPTION_LENGTH,
  packageVersion,
} from './manifest.ts'
import { buildRulesets } from './rules.ts'

const RELEASE_HOSTS = [
  'https://fxm-music.pages.dev/*',
  'https://www.youtube.com/*',
  'https://music.youtube.com/*',
  'https://youtubei.googleapis.com/*',
  'https://*.googlevideo.com/*',
  'https://open.spotify.com/*',
  'https://clienttoken.spotify.com/*',
  'https://api-partner.spotify.com/*',
  'https://spclient.wg.spotify.com/*',
  'https://www.last.fm/*',
]

const VARIANTS = (['chromium', 'firefox'] as const).flatMap((browser) =>
  [false, true].map((dev) => ({ browser, dev })),
)

function manifest(browser: Browser, dev = false) {
  return buildManifest({ browser, version: '1.2.3', dev })
}

describe.each(VARIANTS)('manifest for $browser (dev: $dev)', ({ browser, dev }) => {
  const m = manifest(browser, dev)

  it('is Manifest V3 named FXM Connect with a short description of its purpose', () => {
    expect(m.manifest_version).toBe(3)
    expect(m.name).toBe(dev ? 'FXM Connect (dev)' : 'FXM Connect')
    expect(m.version).toBe('1.2.3')
    expect(m.description).toContain(
      'Only lets the FXM web app reach music services from your own browser.',
    )
    expect(m.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
  })

  it('asks only for static header rules and storage', () => {
    expect(m.permissions).toEqual(['declarativeNetRequest', 'storage'])
    const text = JSON.stringify(m)
    for (const forbidden of [
      '<all_urls>',
      'cookies',
      'tabs',
      'scripting',
      'webRequest',
      'externally_connectable',
      'web_accessible_resources',
      'content_security_policy',
    ]) {
      expect(text).not.toContain(`"${forbidden}"`)
    }
  })

  it('has host access to the FXM pages and the music services only', () => {
    expect(m.host_permissions).toEqual(
      dev ? [RELEASE_HOSTS[0], 'http://localhost/*', ...RELEASE_HOSTS.slice(1)] : RELEASE_HOSTS,
    )
  })

  it('injects the content script into the FXM pages at document_start', () => {
    expect(m.content_scripts).toEqual([
      {
        matches: dev
          ? ['https://fxm-music.pages.dev/*', 'http://localhost/*']
          : ['https://fxm-music.pages.dev/*'],
        js: ['content.js'],
        run_at: 'document_start',
        all_frames: false,
      },
    ])
  })

  it('declares the generated rulesets', () => {
    expect(m.declarative_net_request.rule_resources).toEqual(
      buildRulesets(fxmOrigins(dev)).map(({ id, enabled, path }) => ({ id, enabled, path })),
    )
  })

  it('ships icons at 16, 32, 48 and 128 px and an options page', () => {
    expect(Object.keys(m.icons)).toEqual(ICON_SIZES.map(String))
    expect(m.icons['128']).toBe('icons/icon-128.png')
    expect(m.options_ui).toEqual({ page: 'options.html', open_in_tab: true })
  })
})

describe('Chromium manifest', () => {
  it('uses a background service worker and sets a minimum Chrome version', () => {
    const m = manifest('chromium')
    expect(m.background).toEqual({ service_worker: 'background.js' })
    expect(Number(m.minimum_chrome_version)).toBeGreaterThanOrEqual(102)
    expect(m.browser_specific_settings).toBeUndefined()
  })

  it('matches the reviewed manifest', () => {
    expect(manifest('chromium')).toMatchSnapshot()
  })
})

describe('Firefox manifest', () => {
  it('uses background scripts and declares the Gecko settings', () => {
    const m = manifest('firefox')
    expect(m.background).toEqual({ scripts: ['background.js'] })
    expect(m.minimum_chrome_version).toBeUndefined()
    expect(m.browser_specific_settings).toEqual({
      gecko: {
        id: FIREFOX_ADDON_ID,
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
    })
    expect(FIREFOX_ADDON_ID).toBe('fxm-connect@fxm-music.pages.dev')
  })

  it('requires a Firefox with MV3 declarativeNetRequest', () => {
    const version = manifest('firefox').browser_specific_settings?.gecko.strict_min_version
    expect(Number.parseFloat(version ?? '0')).toBeGreaterThanOrEqual(113)
  })

  it('matches the reviewed manifest', () => {
    expect(manifest('firefox')).toMatchSnapshot()
  })
})

describe('extension version', () => {
  it.each(['0', '1', '0.1.0', '1.2.3.4', '65535.65535.65535.65535', '10.0.20'])(
    'accepts %s',
    (version) => {
      expect(isExtensionVersion(version)).toBe(true)
    },
  )

  it.each([
    '',
    '1.2.3.4.5',
    '01.2',
    '1.02',
    '65536',
    '1.65536',
    '100000',
    '0.2.0-beta.1',
    'v1.2',
    '1..2',
    '1.2.',
    ' 1.2',
  ])('rejects %j', (version) => {
    expect(isExtensionVersion(version)).toBe(false)
    expect(() => buildManifest({ browser: 'chromium', version, dev: false })).toThrow(/version/)
  })

  it('reads it from a parsed package.json', () => {
    expect(packageVersion({ name: 'x', version: '0.3.1' })).toBe('0.3.1')
    for (const bad of [{}, { version: 3 }, { version: '0.2.0-beta.1' }, null, 'version']) {
      expect(() => packageVersion(bad)).toThrow(/package.json needs a version/)
    }
  })
})
