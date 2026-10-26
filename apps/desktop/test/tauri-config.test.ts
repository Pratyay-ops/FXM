import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

/** The Tauri plugins of the shell, as `tauri-plugin-<name>` crates. */
const PLUGINS = ['single-instance', 'window-state', 'http', 'opener']

/** Everything the http plugin may reach: the music, lyrics and metadata hosts. */
const HTTP_HOSTS = [
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
]

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const readJson = <T>(path: string) => JSON.parse(read(path)) as T

const config = readJson<TauriConfig>('../src-tauri/tauri.conf.json')
const capabilityFiles = readdirSync(new URL('../src-tauri/capabilities/', import.meta.url))
const capability = readJson<Record<string, unknown>>('../src-tauri/capabilities/default.json')
const cargoToml = read('../src-tauri/Cargo.toml')
// Without line comments, so commented-out code can't pass a test.
const libRs = read('../src-tauri/src/lib.rs').replace(/\/\/.*$/gm, '')
const webScripts = readJson<{ scripts: Record<string, string> }>('../../web/package.json').scripts

/** Splits a CSP into `{ directive: sources }`. */
function parseCsp(csp: string) {
  const directives = csp
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name)
  return Object.fromEntries(directives.map(([name, ...sources]) => [name, sources]))
}

/** Splits a command line into its arguments. */
const args = (command: string) => command.trim().split(/\s+/)

/** The `--base` arguments of a command, whole: `--base=/app/` is not `--base=/`. */
const baseArgs = (command: string) =>
  args(command).filter((arg) => arg === '--base' || arg.startsWith('--base='))

/** The strings in a TOML array, such as the features of a dependency. */
const tomlStrings = (array = '') => [...array.matchAll(/"([^"]*)"/g)].map(([, value]) => value)

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
    const label = /pub const MAIN_WINDOW: &str = "([^"]+)"/.exec(libRs)
    expect(config.app.windows[0]?.label).toBe(label?.[1])
  })

  it('keeps the content security policy and no other security setting', () => {
    // Capabilities listed here would replace the capabilities/ folder, and settings such as
    // dangerousDisableAssetCspModification or assetProtocol widen what the page may do.
    expect(Object.keys(config.app.security)).toEqual(['csp'])
    expect(parseCsp(config.app.security.csp)).toEqual({
      'default-src': ["'self'"],
      'img-src': ["'self'", 'https:', 'data:', 'blob:'],
      'media-src': ["'self'", 'https:', 'blob:'],
      'connect-src': ['ipc:', 'http://ipc.localhost', "'self'", 'https:'],
      // blob: loads the signed YouTube module (stage 1.13) from a URL made of its verified bytes.
      'script-src': ["'self'", "'wasm-unsafe-eval'", 'blob:'],
      'style-src': ["'self'", "'unsafe-inline'"],
    })
  })

  it('embeds the web build that build:desktop makes with base /', () => {
    const script = webScripts['build:desktop'] ?? ''
    const outDir = /--outDir[= ](\S+)/.exec(script)?.[1]
    expect(baseArgs(script)).toEqual(['--base=/'])
    expect(outDir).toBeDefined()
    expect(config.build.frontendDist).toBe(`../../web/${outDir}`)
    expect(config.build.beforeBuildCommand).toBe('pnpm --filter @fxm/web build:desktop')
  })

  it('develops against a web dev server on the devUrl port, with base /', () => {
    const command = args(config.build.beforeDevCommand)
    expect(baseArgs(config.build.beforeDevCommand)).toEqual(['--base=/'])
    expect(command[command.indexOf('--port') + 1]).toBe(new URL(config.build.devUrl).port)
    expect(command).toContain('--strictPort')
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

describe('capabilities', () => {
  it('has default.json as its only file: Tauri enables every file in the folder', () => {
    expect(capabilityFiles).toEqual(['default.json'])
  })

  it('declares nothing but an identifier, windows and permissions', () => {
    // A `remote` block would open the IPC to remote pages, and `platforms` or `local` would
    // change where the capability applies.
    expect(Object.keys(capability).sort()).toEqual([
      '$schema',
      'description',
      'identifier',
      'permissions',
      'windows',
    ])
  })

  it('applies to the main window only', () => {
    expect(capability.windows).toEqual(['main'])
  })

  it('grants core, opener and the evaluator, and http only for the music, lyrics and metadata hosts', () => {
    expect(capability.permissions).toEqual([
      'core:default',
      'opener:default',
      'fxm-evaluator:default',
      { identifier: 'http:default', allow: HTTP_HOSTS.map((url) => ({ url })) },
    ])
  })
})

describe('Cargo.toml', () => {
  it('builds tauri-plugin-http with unsafe-headers, so requests can set Origin', () => {
    const http = /^tauri-plugin-http = \{([^}]*)\}/m.exec(cargoToml)?.[1] ?? ''
    expect(tomlStrings(/features = \[([^\]]*)\]/.exec(http)?.[1])).toContain('unsafe-headers')
  })

  it('builds tauri-plugin-http without its cookie jar, which saves cookies in plain text', () => {
    const http = /^tauri-plugin-http = \{([^}]*)\}/m.exec(cargoToml)?.[1] ?? ''
    expect(http).toMatch(/\bdefault-features = false\b/)
    expect(tomlStrings(/features = \[([^\]]*)\]/.exec(http)?.[1])).not.toContain('cookies')
  })

  it('includes exactly the plugins of the shell', () => {
    const plugins = [...cargoToml.matchAll(/^tauri-plugin-([a-z-]+) = /gm)].map(([, name]) => name)
    expect(plugins.sort()).toEqual([...PLUGINS].sort())
  })
})

describe('src/lib.rs', () => {
  it('registers every plugin that Cargo.toml includes', () => {
    for (const plugin of PLUGINS) {
      const crate = `tauri_plugin_${plugin.replaceAll('-', '_')}`
      expect(libRs, plugin).toMatch(new RegExp(String.raw`\.plugin\(\s*${crate}::`))
    }
  })
})

describe('rust-toolchain.toml', () => {
  it('pins an exact Rust release instead of a moving channel', () => {
    expect(read('../src-tauri/rust-toolchain.toml')).toMatch(/^channel = "\d+\.\d+\.\d+"$/m)
  })
})
