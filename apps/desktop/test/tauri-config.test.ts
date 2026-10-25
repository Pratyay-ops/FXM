import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Guards the desktop shell's security-relevant configuration. The files are read as plain
// text and JSON, so this runs in `make test` without a Rust toolchain.

interface TauriConfig {
  productName: string
  identifier: string
  build: {
    beforeDevCommand: string
    devUrl: string
    beforeBuildCommand: string
    frontendDist: string
  }
  app: {
    windows: Record<string, unknown>[]
    security: { csp: string }
  }
  bundle: { useLocalToolsDir?: boolean; icon: string[]; createUpdaterArtifacts?: unknown }
  plugins?: Record<string, unknown>
}

type Permission = string | { identifier: string; allow?: { url: string }[] }

interface Capability {
  windows: string[]
  permissions: Permission[]
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const readJson = <T>(path: string) => JSON.parse(read(path)) as T

const config = readJson<TauriConfig>('../src-tauri/tauri.conf.json')
const capability = readJson<Capability>('../src-tauri/capabilities/default.json')
const cargoToml = read('../src-tauri/Cargo.toml')
const webScripts = readJson<{ scripts: Record<string, string> }>('../../web/package.json').scripts

/** Splits a CSP into `{ directive: sources }`. */
function parseCsp(csp: string) {
  const directives = csp
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name)
  return Object.fromEntries(directives.map(([name, ...sources]) => [name, sources]))
}

describe('tauri.conf.json', () => {
  it('identifies the app as FXM', () => {
    expect(config.productName).toBe('FXM')
    expect(config.identifier).toBe('io.github.pratyayops.fxm')
  })

  it('opens one 1200x800 main window that can shrink to 360x600', () => {
    expect(config.app.windows).toHaveLength(1)
    expect(config.app.windows[0]).toMatchObject({
      label: 'main',
      title: 'FXM',
      width: 1200,
      height: 800,
      minWidth: 360,
      minHeight: 600,
    })
  })

  it('names the window that the Rust code brings to the front on a second launch', () => {
    const label = /pub const MAIN_WINDOW: &str = "([^"]+)"/.exec(read('../src-tauri/src/lib.rs'))
    expect(config.app.windows[0]?.label).toBe(label?.[1])
  })

  it('keeps the content security policy', () => {
    expect(parseCsp(config.app.security.csp)).toEqual({
      'default-src': ["'self'"],
      'img-src': ["'self'", 'https:', 'data:', 'blob:'],
      'media-src': ["'self'", 'https:', 'blob:'],
      'connect-src': ['ipc:', 'http://ipc.localhost', "'self'", 'https:'],
      'script-src': ["'self'", "'wasm-unsafe-eval'"],
      'style-src': ["'self'", "'unsafe-inline'"],
    })
  })

  it('embeds the web build that build:desktop makes with base /', () => {
    const script = webScripts['build:desktop'] ?? ''
    const outDir = /--outDir[= ](\S+)/.exec(script)?.[1]
    expect(script).toContain('--base=/')
    expect(outDir).toBeDefined()
    expect(config.build.frontendDist).toBe(`../../web/${outDir}`)
    expect(config.build.beforeBuildCommand).toBe('pnpm --filter @fxm/web build:desktop')
  })

  it('develops against a web dev server on the devUrl port, with base /', () => {
    const { port } = new URL(config.build.devUrl)
    expect(config.build.beforeDevCommand).toContain('--base=/')
    expect(config.build.beforeDevCommand).toContain(`--port ${port} --strictPort`)
  })

  it('downloads bundler tools into the target directory instead of the user cache', () => {
    expect(config.bundle.useLocalToolsDir).toBe(true)
  })

  it('ships every icon it lists', () => {
    for (const icon of config.bundle.icon) {
      expect(existsSync(new URL(`../src-tauri/${icon}`, import.meta.url)), icon).toBe(true)
    }
  })

  it('has no updater yet (stage 7.5 adds it)', () => {
    expect(config.plugins?.updater).toBeUndefined()
    expect(config.bundle.createUpdaterArtifacts).toBeUndefined()
    expect(cargoToml).not.toContain('tauri-plugin-updater')
  })
})

describe('capabilities/default.json', () => {
  it('applies to the main window only', () => {
    expect(capability.windows).toEqual(['main'])
  })

  it('lets the http plugin reach only the music, lyrics and metadata hosts', () => {
    const http = capability.permissions.find(
      (permission) => typeof permission === 'object' && permission.identifier === 'http:default',
    )
    const urls = typeof http === 'object' ? http.allow?.map(({ url }) => url) : undefined
    expect(urls).toEqual([
      'https://www.youtube.com/*',
      'https://music.youtube.com/*',
      'https://youtubei.googleapis.com/*',
      'https://*.googlevideo.com/*',
      'https://i.ytimg.com/*',
      'https://open.spotify.com/*',
      'https://clienttoken.spotify.com/*',
      'https://api-partner.spotify.com/*',
      'https://spclient.wg.spotify.com/*',
      'https://lrclib.net/*',
      'https://musicbrainz.org/*',
      'https://api.listenbrainz.org/*',
      'https://ws.audioscrobbler.com/*',
      'https://www.last.fm/*',
      'https://archive.org/*',
      'https://*.archive.org/*',
      'https://api.jamendo.com/*',
      'https://*.jamendo.com/*',
    ])
  })
})

describe('Cargo.toml', () => {
  it('builds tauri-plugin-http with unsafe-headers, so requests can set Origin', () => {
    expect(cargoToml).toMatch(/^tauri-plugin-http = \{[^}]*features = \["unsafe-headers"\]/m)
  })

  it('includes the single-instance, window-state and opener plugins', () => {
    for (const plugin of ['single-instance', 'window-state', 'opener']) {
      expect(cargoToml).toMatch(new RegExp(`^tauri-plugin-${plugin} = `, 'm'))
    }
  })
})

describe('rust-toolchain.toml', () => {
  it('pins an exact Rust release instead of a moving channel', () => {
    expect(read('../src-tauri/rust-toolchain.toml')).toMatch(/^channel = "\d+\.\d+\.\d+"$/m)
  })
})
