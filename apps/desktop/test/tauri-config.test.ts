import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { HOST_RULES, type HostRule, NATIVE_ORIGINS } from '@fxm/platform'
import { describe, expect, it } from 'vitest'
import { decodePublicKey } from '../release/minisign.ts'

// Guards the desktop shell's security-relevant configuration. The files are read as plain
// text and JSON, so this runs in `make test` without a Rust toolchain.

interface TauriConfig {
  productName: string
  identifier: string
  version: string
  build: {
    beforeDevCommand: string
    devUrl: string
    beforeBuildCommand: string
    frontendDist: string
  }
  app: {
    windows: Record<string, unknown>[]
    security: { csp: string; pattern?: unknown }
  }
  bundle: {
    useLocalToolsDir?: boolean
    icon: string[]
    createUpdaterArtifacts?: unknown
    macOS: Record<string, unknown>
    linux: { deb: { section: string; depends: string[] }; appimage: Record<string, unknown> }
  }
  plugins: { http: unknown; updater: Record<string, unknown> & { pubkey: string } }
}

/** A rule in the shape of the `requestHeaders` option that plugins-workspace PR #3703 proposes. */
interface RequestHeaderRule {
  url: string
  headers: Record<string, string | null>
  mode?: 'default' | 'override'
}

/**
 * The Tauri plugins of the shell, as `tauri-plugin-<name>` crates. Not tauri-plugin-dialog: its
 * script would replace `window.alert` and `window.confirm` in every page with IPC calls the app
 * doesn't allow, so `confirm()` would return a Promise, which is always truthy.
 */
const PLUGINS = ['single-instance', 'window-state', 'http', 'opener', 'updater']

/** Where installed apps look for a newer version: latest.json of the latest release. */
const UPDATE_ENDPOINT = 'https://github.com/Pratyay-ops/FXM/releases/latest/download/latest.json'

/** The app's own Rust commands: src/user_hosts.rs, then src/playback.rs and src/environment.rs. */
const COMMANDS = [
  'user_hosts',
  'approve_user_host',
  'revoke_user_host',
  'user_host_fetch',
  'set_now_playing',
  'desktop_environment',
]

/**
 * The core permissions of the web app: Tauri's `core:default` without `core:menu:default` and
 * `core:tray:default`, so the tray and its menu stay Rust's (src/tray.rs).
 */
const CORE_PERMISSIONS = [
  'core:app:default',
  'core:event:default',
  'core:image:default',
  'core:path:default',
  'core:resources:default',
  'core:webview:default',
  'core:window:default',
]

/**
 * The app's own plugin, built into its crate (`InlinedPlugin` in build.rs): stage 1.11's isolated
 * evaluator (src/evaluator.rs), with the commands the web app calls.
 */
const EVALUATOR_PLUGIN = 'fxm-evaluator'
const EVALUATOR_COMMANDS = ['open', 'eval', 'close']

/** The scope entry of a host in the platform's host table, which is FXM's network allow-list. */
const scopeEntry = (rule: HostRule) => `https://${rule.host}${rule.pathPrefix ?? '/'}*`

/**
 * Entries of the host table that the scope leaves out: BotGuard's interpreter, which only stage
 * 1.11's PO-token rungs fetch. Those need an evaluator document at YouTube's origin, which the
 * desktop app's isn't (packages/sources/src/youtube/stream/advanced/README.md), so the app never
 * asks for it. Adding it to the scope is a deliberate change for when it does.
 */
const LEFT_OUT_OF_SCOPE = ['https://www.google.com/js/th/*']

/** Everything the http plugin may reach: the platform's host table, less those entries. */
const HTTP_SCOPE = HOST_RULES.map(scopeEntry).filter((entry) => !LEFT_OUT_OF_SCOPE.includes(entry))

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const readJson = <T>(path: string) => JSON.parse(read(path)) as T

const config = readJson<TauriConfig>('../src-tauri/tauri.conf.json')
const capabilityFiles = readdirSync(new URL('../src-tauri/capabilities/', import.meta.url))
const capability = readJson<{ permissions: unknown[] } & Record<string, unknown>>(
  '../src-tauri/capabilities/default.json',
)
const isolationHtml = read('../isolation/index.html')
const isolationHook = read('../isolation/hook.js')
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

/** The inline table of a dependency in Cargo.toml, e.g. `{ version = "…", features = […] }`. */
const dependency = (name: string) =>
  new RegExp(String.raw`^${name} = \{([^}]*)\}`, 'm').exec(cargoToml)?.[1] ?? ''

/** The features a dependency in Cargo.toml turns on. */
const featuresOf = (name: string) =>
  tomlStrings(/features = \[([^\]]*)\]/.exec(dependency(name))?.[1])

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

  it('keeps the page running while the window is hidden, for background playback', () => {
    // WebKit's inactive scheduling policy on macOS 14 and later; Windows and Linux hold a Web
    // Lock instead (bridge/keep-awake.ts).
    expect(config.app.windows[0]?.backgroundThrottling).toBe('disabled')
  })

  it('keeps the content security policy, the isolation pattern and no other security setting', () => {
    // Capabilities listed here would replace the capabilities/ folder, and settings such as
    // dangerousDisableAssetCspModification or assetProtocol widen what the page may do.
    expect(Object.keys(config.app.security)).toEqual(['csp', 'pattern'])
    expect(parseCsp(config.app.security.csp)).toEqual({
      'default-src': ["'self'"],
      'img-src': ["'self'", 'https:', 'data:', 'blob:'],
      // fxm-media: the readable audio path (stage 7.6), in its macOS/Linux and Windows forms.
      'media-src': ["'self'", 'https:', 'blob:', 'fxm-media:', 'http://fxm-media.localhost'],
      'connect-src': ['ipc:', 'http://ipc.localhost', "'self'"],
      // blob: loads the signed YouTube module (stage 1.13) from a URL made of its verified bytes.
      'script-src': ["'self'", "'wasm-unsafe-eval'", 'blob:'],
      'style-src': ["'self'", "'unsafe-inline'"],
    })
  })

  it('passes IPC messages through the isolation hook in ../isolation', () => {
    expect(config.app.security.pattern).toEqual({
      use: 'isolation',
      options: { dir: '../isolation' },
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

  it('lets <audio> load the readable audio path, but never lets page script fetch from it', () => {
    // Stage 7.6: googlevideo streams served by Rust under the app's own scheme, with CORS for the
    // app, so Web Audio can read them (src/media.rs). Elements load it; fetch() can't.
    const { 'media-src': media = [], 'connect-src': connect = [] } = parseCsp(
      config.app.security.csp,
    )
    expect(media).toEqual(expect.arrayContaining(['fxm-media:', 'http://fxm-media.localhost']))
    expect(connect).not.toContain('fxm-media:')
    expect(connect).not.toContain('http://fxm-media.localhost')
  })

  it('sends the page’s requests only through Tauri’s IPC, so only Rust reaches the network', () => {
    const connect = parseCsp(config.app.security.csp)['connect-src'] ?? []
    expect(cspAllows(connect, 'https://music.youtube.com/youtubei/v1/search')).toBe(false)
    expect(cspAllows(connect, 'https://lrclib.net/api/get')).toBe(false)
  })

  it('checks every redirect against the http scope', () => {
    // The plugin's config refuses unknown keys, so a typo here would stop the app at start-up.
    expect(config.plugins.http).toEqual({ scopeRedirects: true })
    expect(Object.keys(config.plugins).sort()).toEqual(['http', 'updater'])
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

  it('takes its version from its package.json, which every release sets', () => {
    expect(config.version).toBe('../package.json')
  })
})

describe('the updater', () => {
  const { updater } = config.plugins

  it('looks for updates in latest.json of the latest release on GitHub, over HTTPS only', () => {
    expect(updater.endpoints).toEqual([UPDATE_ENDPOINT])
    for (const setting of [
      'dangerousInsecureTransportProtocol',
      'dangerousAcceptInvalidCerts',
      'dangerousAcceptInvalidHostnames',
      'allowDowngrades',
    ]) {
      expect(updater[setting], setting).toBeUndefined()
    }
  })

  it('needs each signature to name the version latest.json announces', () => {
    // So an older, validly signed release can't pass for a newer one.
    expect(updater.requireSignedVersion).toBe(true)
  })

  it('installs on Windows with a progress bar, then opens FXM again', () => {
    expect(updater.windows).toEqual({ installMode: 'passive' })
  })

  it('carries FXM’s updater key, or the placeholder that stops every release', () => {
    if (updater.pubkey.startsWith('PLACEHOLDER')) {
      // Not base64, so `tauri build` fails on it once the updater's files are on
      // (tauri.release.conf.json), and release.ts check refuses it.
      expect(() => decodePublicKey(updater.pubkey)).toThrow()
    } else {
      expect(decodePublicKey(updater.pubkey).key).toHaveLength(32)
    }
  })

  it('makes no updater files in local builds, which then need no key', () => {
    // The release workflow turns them on with tauri.release.conf.json.
    expect(config.bundle.createUpdaterArtifacts).toBeUndefined()
  })
})

describe('the bundles', () => {
  it('sign the macOS app ad hoc, so macOS offers "Open Anyway" instead of calling it damaged', () => {
    expect(config.bundle.macOS).toEqual({ minimumSystemVersion: '11.0', signingIdentity: '-' })
  })

  it('make the .deb depend on the GStreamer plugins WebKitGTK plays music with', () => {
    // Opus and MP3 need base and good, AAC needs libav, and nothing plays without an audio output.
    expect(config.bundle.linux.deb).toEqual({
      section: 'sound',
      depends: [
        'gstreamer1.0-plugins-base',
        'gstreamer1.0-plugins-good',
        'gstreamer1.0-libav',
        'gstreamer1.0-pulseaudio | gstreamer1.0-alsa',
      ],
    })
  })

  it('give the AppImage GStreamer of its own, since it plays with its own libraries', () => {
    expect(config.bundle.linux.appimage).toEqual({ bundleMediaFramework: true })
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

  it('declares nothing but an identifier, webviews and permissions', () => {
    // A `remote` block would open the IPC to remote pages, and `platforms` or `local` would
    // change where the capability applies.
    expect(Object.keys(capability).sort()).toEqual([
      '$schema',
      'description',
      'identifier',
      'permissions',
      'webviews',
    ])
  })

  it('applies to the main window’s own webview only, not to every webview in that window', () => {
    // A capability matched by window applies to every webview of the window, so a child webview
    // would get all of it. The main window's webview has the window's label; stage 1.11's
    // evaluator is a window of its own, whose label no capability names.
    expect(capability.webviews).toEqual([config.app.windows[0]?.label])
    expect(capability.windows).toBeUndefined()
  })

  it('grants core, opener, the evaluator, the app’s commands and http, and nothing else', () => {
    expect(capability.permissions).toEqual([
      ...CORE_PERMISSIONS,
      'opener:default',
      `${EVALUATOR_PLUGIN}:default`,
      ...COMMANDS.map((command) => `allow-${command.replaceAll('_', '-')}`),
      { identifier: 'http:default', allow: expect.any(Array) },
    ])
  })

  it('leaves the tray and menus to Rust: page script can’t change them or add its own', () => {
    // core:default would include core:tray:default and core:menu:default.
    const names = capability.permissions.filter((permission) => typeof permission === 'string')
    expect(names).not.toContain('core:default')
    expect(names.filter((name) => /^core:(tray|menu):/.test(name))).toEqual([])
  })

  it('lets the http plugin reach exactly the platform’s host table, less the entries left out', () => {
    expect(http?.allow.map(({ url }) => url).sort()).toEqual([...HTTP_SCOPE].sort())
  })

  it('leaves out of the scope only entries the host table has', () => {
    // So the list of exceptions can't outlive the host-table rows it stands for.
    expect(HOST_RULES.map(scopeEntry)).toEqual(expect.arrayContaining(LEFT_OUT_OF_SCOPE))
  })

  it('narrows Last.fm to its station JSON, as the host table does', () => {
    expect(http?.allow).toContainEqual({ url: 'https://www.last.fm/player/station/*' })
    expect(http?.allow).not.toContainEqual({ url: 'https://www.last.fm/*' })
  })

  it('gives the web app no updater permission: only Rust checks for, downloads and installs updates', () => {
    const names = capability.permissions.map((permission) =>
      typeof permission === 'string'
        ? permission
        : (permission as { identifier: string }).identifier,
    )
    expect(names.filter((name) => name.startsWith('updater:'))).toEqual([])
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
    const registered = [...handler.matchAll(/\w+::(\w+)/g)].map(([, name]) => name)
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
      // `null` is no Origin at all, in the rules as in the transports.
      expect(originFor(sampleUrl(rule)), rule.host).toBe(NATIVE_ORIGINS[rule.hostClass])
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
    // Hidden and never suspended, as the app's own window is in the background (stage 7.3): the
    // smoke test checks that streams play to their end in a hidden window.
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
  const http = dependency('tauri-plugin-http')

  it('builds tauri-plugin-http with unsafe-headers, so requests can set or drop Origin', () => {
    // Until plugins-workspace PR #3703 lets request-headers.json do it from the config.
    expect(featuresOf('tauri-plugin-http')).toContain('unsafe-headers')
  })

  it('builds tauri-plugin-http without its cookie jar, which saves cookies in plain text', () => {
    expect(http).toMatch(/\bdefault-features = false\b/)
    expect(featuresOf('tauri-plugin-http')).not.toContain('cookies')
  })

  it('lets responses arrive compressed, as in a browser', () => {
    // The plugin asks for `identity` whenever a request has a Range header, so media probes
    // stay byte for byte.
    expect(featuresOf('tauri-plugin-http')).toEqual(expect.arrayContaining(['gzip', 'brotli']))
  })

  it('builds tauri and tauri-build with the isolation pattern, which the config alone can’t turn on', () => {
    // Without the feature, Tauri quietly falls back to the brownfield pattern.
    expect(featuresOf('tauri')).toContain('isolation')
    expect(featuresOf('tauri-build')).toContain('isolation')
  })

  it('shows the approval dialog with rfd: GTK 3 on Linux, task dialogs on Windows', () => {
    expect(dependency('rfd')).toMatch(/\bdefault-features = false\b/)
    expect(featuresOf('rfd').sort()).toEqual(['common-controls-v6', 'gtk3'])
  })

  it('builds tauri with its tray icon, which the playback menu needs (src/tray.rs)', () => {
    // And with nothing else but the isolation pattern (stage 7.2).
    expect(featuresOf('tauri').sort()).toEqual(['isolation', 'tray-icon'])
  })

  it('starts the smoke test’s report listener only on request, never by default', () => {
    const features = /^\[features\]\n((?:.*\n)*?)\n/m.exec(cargoToml)?.[1] ?? ''
    expect(features).toMatch(/^smoke = \[\]$/m)
    expect(features).not.toMatch(/^default = /m)
    expect(libRs).toMatch(/#\[cfg\(feature = "smoke"\)\]\s*smoke::listen\(/)
    expect(libRs.match(/smoke::listen\(/g)).toHaveLength(1)
  })

  it('builds tauri-plugin-updater without the zip feature, for Tauri 1 bundles only', () => {
    expect(dependency('tauri-plugin-updater')).toMatch(/\bdefault-features = false\b/)
    expect(featuresOf('tauri-plugin-updater').sort()).toEqual(['rustls-tls', 'system-proxy'])
  })

  it('includes exactly the plugins of the shell', () => {
    const plugins = [...cargoToml.matchAll(/^tauri-plugin-([a-z-]+) = /gm)].map(([, name]) => name)
    expect(plugins.sort()).toEqual([...PLUGINS].sort())
  })
})

describe('the isolation app', () => {
  it('loads the hook, which Tauri inlines when it builds the app', () => {
    expect(isolationHtml).toMatch(/<script src="hook\.js"><\/script>/)
    // Tauri refuses to build an isolation app that sets no hook.
    expect(isolationHook).toMatch(/window\.__TAURI_ISOLATION_HOOK__ = /)
  })

  it('is rebuilt into the app whenever it changes', () => {
    expect(buildRs).toMatch(/println!\("cargo:rerun-if-changed=\.\.\/isolation"\)/)
  })
})

describe('src/lib.rs', () => {
  it('registers every plugin that Cargo.toml includes', () => {
    for (const plugin of PLUGINS) {
      const crate = `tauri_plugin_${plugin.replaceAll('-', '_')}`
      expect(libRs, plugin).toMatch(new RegExp(String.raw`\.plugin\(\s*${crate}::`))
    }
  })

  it('registers exactly those plugins and the app’s own evaluator', () => {
    const registered = [...libRs.matchAll(/\.plugin\(\s*(\w+)::/g)].map(([, module]) => module)
    const crates = PLUGINS.map((plugin) => `tauri_plugin_${plugin.replaceAll('-', '_')}`)
    expect(registered.sort()).toEqual([...crates, 'evaluator'].sort())
  })

  it('registers the evaluator plugin that build.rs declares, with its commands', () => {
    expect(libRs).toMatch(/\.plugin\(\s*evaluator::init\(\)\s*\)/)
    expect(buildRs).toMatch(
      new RegExp(String.raw`\.plugin\(\s*"${EVALUATOR_PLUGIN}",\s*evaluator\s*\)`),
    )
    const declared = /InlinedPlugin::new\(\)\s*\.commands\(&\[([^\]]*)\]\)/.exec(buildRs)?.[1]
    expect(rustStrings(declared)).toEqual(EVALUATOR_COMMANDS)
  })
})

describe('rust-toolchain.toml', () => {
  it('pins an exact Rust release instead of a moving channel', () => {
    expect(read('../src-tauri/rust-toolchain.toml')).toMatch(/^channel = "\d+\.\d+\.\d+"$/m)
  })
})
