import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { HOST_RULES, type HostRule, NATIVE_ORIGINS } from '@fxm/platform'
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

/** A rule in the shape of the `requestHeaders` option that plugins-workspace PR #3703 proposes. */
interface RequestHeaderRule {
  url: string
  headers: Record<string, string | null>
  mode?: 'default' | 'override'
}

/** The Tauri plugins of the shell, as `tauri-plugin-<name>` crates. */
const PLUGINS = ['single-instance', 'window-state', 'http', 'dialog', 'opener']

/** The app's own Rust commands (src/user_hosts.rs). */
const COMMANDS = ['user_hosts', 'approve_user_host', 'revoke_user_host', 'user_host_fetch']

/** The scope entry of a host in the platform's host table, which is FXM's network allow-list. */
const scopeEntry = (rule: HostRule) => `https://${rule.host}${rule.pathPrefix ?? '/'}*`

/** Everything the http plugin may reach: exactly the hosts in the platform's host table. */
const HTTP_SCOPE = HOST_RULES.map(scopeEntry)

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const readJson = <T>(path: string) => JSON.parse(read(path)) as T

const config = readJson<TauriConfig>('../src-tauri/tauri.conf.json')
const capabilityFiles = readdirSync(new URL('../src-tauri/capabilities/', import.meta.url))
const capability = readJson<{ permissions: unknown[] } & Record<string, unknown>>(
  '../src-tauri/capabilities/default.json',
)
const requestHeaders = readJson<{ requestHeaders: RequestHeaderRule[] }>(
  '../src-tauri/request-headers.json',
).requestHeaders
const smokeConfig = readJson<Record<string, unknown>>('../src-tauri/tauri.smoke.conf.json')
const cargoToml = read('../src-tauri/Cargo.toml')
// Without line comments, so commented-out code can't pass a test.
const withoutComments = (source: string) => source.replace(/\/\/.*$/gm, '')
const libRs = withoutComments(read('../src-tauri/src/lib.rs'))
const buildRs = withoutComments(read('../src-tauri/build.rs'))
const webScripts = readJson<{ scripts: Record<string, string> }>('../../web/package.json').scripts

/** Splits a CSP into `{ directive: sources }`. */
function parseCsp(csp: string) {
  const directives = csp
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name)
  return Object.fromEntries(directives.map(([name, ...sources]) => [name, sources]))
}

/** Whether a CSP source list lets the page load `url` (scheme and host sources only). */
function cspAllows(sources: string[], url: string) {
  const { protocol, hostname } = new URL(url)
  return sources.some((source) => {
    if (source === protocol) return true
    const match = /^(https?:)\/\/(\*\.)?([^/:]+)$/.exec(source)
    if (!match || match[1] !== protocol) return false
    const [, , wildcard, host] = match
    return wildcard ? hostname.endsWith(`.${host}`) : hostname === host
  })
}

/** Whether a scope or rule pattern such as `https://*.archive.org/*` matches `url`. */
function patternMatches(pattern: string, url: string) {
  const toRegExp = (part: string) =>
    part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${toRegExp(pattern)}$`).test(url)
}

/** A URL the host rule covers, e.g. `https://ia800.archive.org/x` for `*.archive.org`. */
const sampleUrl = (rule: HostRule) =>
  `https://${rule.host.replace('*.', 'sub.')}${rule.pathPrefix ?? '/'}x`

/** Splits a command line into its arguments. */
const args = (command: string) => command.trim().split(/\s+/)

/** The `--base` arguments of a command, whole: `--base=/app/` is not `--base=/`. */
const baseArgs = (command: string) =>
  args(command).filter((arg) => arg === '--base' || arg.startsWith('--base='))

/** The strings in a TOML array, such as the features of a dependency. */
const tomlStrings = (array = '') => [...array.matchAll(/"([^"]*)"/g)].map(([, value]) => value)

/** The quoted strings of a Rust array or macro list. */
const rustStrings = (list = '') => [...list.matchAll(/"([^"]*)"/g)].map(([, value]) => value)

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
      'connect-src': ['ipc:', 'http://ipc.localhost', "'self'"],
      'script-src': ["'self'", "'wasm-unsafe-eval'"],
      'style-src': ["'self'", "'unsafe-inline'"],
    })
  })

  it('never allows eval: the YouTube evaluator gets a webview of its own (stage 1.11)', () => {
    expect(config.app.security.csp).not.toContain("'unsafe-eval'")
  })

  it('lets <audio> play googlevideo, Internet Archive and Jamendo URLs', () => {
    const media = parseCsp(config.app.security.csp)['media-src'] ?? []
    for (const url of [
      'https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback?itag=251',
      'https://ia800300.us.archive.org/1/items/x/x.flac',
      'https://prod-1.storage.jamendo.com/?trackid=1&format=flac',
    ]) {
      expect(cspAllows(media, url), url).toBe(true)
    }
  })

  it('sends the page’s requests only through Tauri’s IPC, so only Rust reaches the network', () => {
    const connect = parseCsp(config.app.security.csp)['connect-src'] ?? []
    expect(cspAllows(connect, 'https://music.youtube.com/youtubei/v1/search')).toBe(false)
    expect(cspAllows(connect, 'https://lrclib.net/api/get')).toBe(false)
  })

  it('checks every redirect against the http scope', () => {
    // The plugin's config refuses unknown keys, so a typo here would stop the app at start-up.
    expect(config.plugins).toEqual({ http: { scopeRedirects: true } })
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
  const http = capability.permissions.find(
    (permission): permission is { identifier: string; allow: { url: string }[] } =>
      typeof permission === 'object' &&
      (permission as { identifier?: unknown }).identifier === 'http:default',
  )

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

  it('grants core, opener, the app’s commands and http, and nothing else', () => {
    expect(capability.permissions).toEqual([
      'core:default',
      'opener:default',
      ...COMMANDS.map((command) => `allow-${command.replaceAll('_', '-')}`),
      { identifier: 'http:default', allow: expect.any(Array) },
    ])
  })

  it('lets the http plugin reach exactly the hosts in the platform’s host table', () => {
    expect(http?.allow.map(({ url }) => url).sort()).toEqual([...HTTP_SCOPE].sort())
  })

  it('narrows Last.fm to its station JSON, as the host table does', () => {
    expect(http?.allow).toContainEqual({ url: 'https://www.last.fm/player/station/*' })
    expect(http?.allow).not.toContainEqual({ url: 'https://www.last.fm/*' })
  })

  it('gives the web app no dialog permission: only Rust asks the user', () => {
    const names = capability.permissions.map((permission) =>
      typeof permission === 'string'
        ? permission
        : (permission as { identifier: string }).identifier,
    )
    expect(names.filter((name) => name.startsWith('dialog:'))).toEqual([])
  })
})

describe('the app’s commands', () => {
  it('are the same in build.rs, which puts each behind a permission, and in lib.rs', () => {
    const manifest = /const COMMANDS: &\[&str\] = &\[([^\]]*)\]/.exec(buildRs)?.[1]
    expect(rustStrings(manifest)).toEqual(COMMANDS)
    expect(buildRs).toMatch(
      /\.app_manifest\(\s*tauri_build::AppManifest::new\(\)\.commands\(COMMANDS\)/,
    )
    const handler = /generate_handler!\[([^\]]*)\]/.exec(libRs)?.[1] ?? ''
    const registered = [...handler.matchAll(/user_hosts::(\w+)/g)].map(([, name]) => name)
    expect(registered).toEqual(COMMANDS)
  })
})

describe('request-headers.json (staged for plugins-workspace PR #3703)', () => {
  /** The Origin the rules give `url`: the last matching rule wins, `null` removes it. */
  function originFor(url: string) {
    let origin: string | null | undefined
    for (const rule of requestHeaders) {
      if (patternMatches(rule.url, url) && 'Origin' in rule.headers) origin = rule.headers.Origin
    }
    return origin
  }

  it('gives every host in the table the Origin the native transports send', () => {
    for (const rule of HOST_RULES) {
      const expected = NATIVE_ORIGINS[rule.hostClass] === '' ? null : NATIVE_ORIGINS[rule.hostClass]
      expect(originFor(sampleUrl(rule)), rule.host).toBe(expected)
    }
  })

  it('never lets the webview’s Origin through, whatever the frontend sends', () => {
    expect(originFor('https://unknown.example.org/x')).toBeNull()
    for (const rule of requestHeaders) {
      expect(rule.mode).toBe('override')
      expect(Object.keys(rule.headers)).toEqual(['Origin'])
    }
  })
})

describe('tauri.smoke.conf.json (the live smoke test)', () => {
  it('renames the app, embeds the smoke page and hides the window, and changes nothing else', () => {
    // Merged over tauri.conf.json by `tauri build --config`: anything security-related here would
    // make the smoke test check something other than the app.
    expect(Object.keys(smokeConfig).sort()).toEqual(['$schema', 'app', 'build', 'identifier'])
    expect(smokeConfig.identifier).toBe(`${config.identifier}.smoke`)
    expect(smokeConfig.build).toEqual({
      beforeBuildCommand: 'pnpm --filter @fxm/desktop smoke:page',
      frontendDist: '../smoke/dist',
    })
    // Hidden and never suspended: stage 7.3 decides how the app's own window behaves in the
    // background; the smoke test checks that a stream plays to its end.
    expect(smokeConfig.app).toEqual({
      windows: [
        expect.objectContaining({
          label: 'main',
          visible: false,
          backgroundThrottling: 'disabled',
        }),
      ],
    })
  })
})

describe('Cargo.toml', () => {
  const http = /^tauri-plugin-http = \{([^}]*)\}/m.exec(cargoToml)?.[1] ?? ''

  it('builds tauri-plugin-http with unsafe-headers, so requests can set or drop Origin', () => {
    // Until plugins-workspace PR #3703 lets request-headers.json do it from the config.
    expect(tomlStrings(/features = \[([^\]]*)\]/.exec(http)?.[1])).toContain('unsafe-headers')
  })

  it('builds tauri-plugin-http without its cookie jar, which saves cookies in plain text', () => {
    expect(http).toMatch(/\bdefault-features = false\b/)
    expect(tomlStrings(/features = \[([^\]]*)\]/.exec(http)?.[1])).not.toContain('cookies')
  })

  it('starts the smoke test’s report listener only on request, never by default', () => {
    const features = /^\[features\]\n((?:.*\n)*?)\n/m.exec(cargoToml)?.[1] ?? ''
    expect(features).toMatch(/^smoke = \[\]$/m)
    expect(features).not.toMatch(/^default = /m)
    expect(libRs).toMatch(/#\[cfg\(feature = "smoke"\)\]\s*smoke::listen\(/)
    expect(libRs.match(/smoke::listen\(/g)).toHaveLength(1)
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
