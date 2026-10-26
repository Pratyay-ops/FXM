import { readFileSync } from 'node:fs'
import { type Codec, type Container, containerExtension, DOWNLOAD_FORMATS } from '@fxm/core'
import { MAX_DOWNLOAD_BYTES } from '@fxm/downloads'
import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_COMMANDS,
  DOWNLOAD_SCHEME,
  DOWNLOADS_PLUGIN,
  SPOTIFY_COMMANDS,
  SPOTIFY_LOGIN_EVENT,
  SPOTIFY_PLUGIN,
} from '../bridge'

// Keeps the bridge's downloads and Spotify login (bridge/downloads.ts, bridge/spotify-login.ts)
// in step with their Rust plugins (src-tauri/src/downloads.rs, src-tauri/src/spotify_login.rs),
// whose sources are read as text, so this runs in `make test` without a Rust toolchain. Their
// behaviour is tested by `cargo test` (make desktop-check).

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const withoutComments = (source: string) => source.replace(/\/\/.*$/gm, '')
const rust = (file: string) => withoutComments(read(`../src-tauri/src/${file}`))

const downloadsRs = rust('downloads.rs')
const spotifyRs = rust('spotify_login.rs')
const libRs = rust('lib.rs')
const buildRs = withoutComments(read('../src-tauri/build.rs'))
const config = JSON.parse(read('../src-tauri/tauri.conf.json')) as {
  app: { security: { csp: string } }
}
const capability = JSON.parse(read('../src-tauri/capabilities/default.json')) as {
  webviews: string[]
  permissions: unknown[]
}

/** The string value of `pub const NAME: &str = "…";` in a Rust source. */
function rustConst(source: string, name: string): string | undefined {
  return new RegExp(`pub const ${name}: &str =\\s*"([^"]*)";`).exec(source)?.[1]
}

/** The quoted strings of a Rust array or macro list. */
const rustStrings = (list = ''): string[] =>
  [...list.matchAll(/"([^"]*)"/g)].map(([, value = '']) => value)

/** The commands an inlined plugin declares in build.rs, by the plugin's variable name. */
function declaredCommands(variable: string): string[] {
  const block = new RegExp(
    String.raw`let ${variable} = tauri_build::InlinedPlugin::new\(\)\s*\.commands\(&\[([^\]]*)\]\)`,
  ).exec(buildRs)?.[1]
  return rustStrings(block)
}

/** The commands a plugin's `generate_handler!` registers. */
function registeredCommands(source: string): string[] {
  const list = /generate_handler!\[([^\]]*)\]/.exec(source)?.[1] ?? ''
  return list
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

const camel = (name: string) => name.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase())

/** The arguments of a Rust command, as the web app names them (Tauri expects camelCase). */
function commandArguments(source: string, command: string): string[] {
  const signature = new RegExp(
    String.raw`#\[tauri::command\]\s*async fn ${command}(?:<[^>]*>)?\(([^)]*)\)`,
  ).exec(source)
  expect(signature, `no command ${command}`).not.toBeNull()
  let list = signature?.[1] ?? ''
  while (/<[^<>]*>/.test(list)) list = list.replace(/<[^<>]*>/g, '')
  return list
    .split(',')
    .map((parameter) => parameter.trim())
    .filter(
      (parameter) => parameter !== '' && !/:\s*(?:AppHandle|State|WebviewWindow)\b/.test(parameter),
    )
    .map((parameter) => camel(parameter.split(':')[0]?.trim() ?? ''))
}

/** The fields of a Rust struct, as serde names them in camelCase. */
function structFields(source: string, name: string): string[] {
  const body = new RegExp(String.raw`pub struct ${name} \{([^}]*)\}`).exec(source)?.[1] ?? ''
  return [...body.matchAll(/^\s*(?:pub )?(\w+):/gm)].map(([, field = '']) => camel(field))
}

/** Splits a CSP into `{ directive: sources }`. */
function parseCsp(csp: string) {
  const directives = csp
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name)
  return Object.fromEntries(directives.map(([name, ...sources]) => [name, sources]))
}

describe('the downloads plugin and the bridge agree on', () => {
  it('the plugin, its commands in build.rs and in its handler', () => {
    expect(rustConst(downloadsRs, 'PLUGIN')).toBe(DOWNLOADS_PLUGIN)
    const commands = Object.values(DOWNLOAD_COMMANDS)
    expect(declaredCommands('downloads')).toEqual(commands)
    expect(registeredCommands(downloadsRs)).toEqual(commands)
    expect(buildRs).toMatch(/\.plugin\("fxm-downloads", downloads\)/)
  })

  it('the arguments the bridge sends each command', () => {
    const expected: Record<string, string[]> = {
      open: ['file'],
      write: ['file', 'offset', 'data'],
      truncate: ['file', 'size'],
      flush: ['file'],
      close: ['file'],
      remove: ['file'],
      list: [],
      size: ['file'],
      read: ['file'],
      name: ['file', 'fileName'],
      folder: [],
      choose_folder: [],
      save_begin: ['fileName'],
      save_write: ['id', 'offset', 'data'],
      save_end: ['id', 'keep'],
    }
    for (const command of Object.values(DOWNLOAD_COMMANDS)) {
      expect(commandArguments(downloadsRs, command), command).toEqual(expected[command])
    }
  })

  it('the fields of what the commands answer, in camelCase', () => {
    for (const name of ['FolderInfo', 'Listing', 'SaveStarted']) {
      expect(downloadsRs).toMatch(
        new RegExp(String.raw`#\[serde\(rename_all = "camelCase"\)\]\s*pub struct ${name}`),
      )
    }
    expect(structFields(downloadsRs, 'FolderInfo')).toEqual(['path', 'chosen'])
    expect(structFields(downloadsRs, 'Listing')).toEqual(['partial', 'named'])
    expect(structFields(downloadsRs, 'SaveStarted')).toEqual(['id', 'fileName'])
  })

  it('the playback scheme, which the main window’s policy lets media load from', () => {
    expect(rustConst(downloadsRs, 'SCHEME')).toBe(DOWNLOAD_SCHEME)
    expect(rustConst(downloadsRs, 'WINDOWS_HOST')).toBe(`${DOWNLOAD_SCHEME}.localhost`)
    const media = parseCsp(config.app.security.csp)['media-src'] ?? []
    expect(media).toEqual(
      expect.arrayContaining([`${DOWNLOAD_SCHEME}:`, `http://${DOWNLOAD_SCHEME}.localhost`]),
    )
    // Page script reads no file through fetch(): the scheme is for media elements only.
    expect(parseCsp(config.app.security.csp)['connect-src']).not.toContain(`${DOWNLOAD_SCHEME}:`)
    // Only the main window's webview gets an answer.
    expect(downloadsRs).toMatch(
      /if webview != MAIN_WINDOW \{\s*return status\(StatusCode::FORBIDDEN\);/,
    )
  })

  it('the names a file may have, as the download manager’s isSafeFileName', () => {
    const devices = rustStrings(
      /const DEVICE_NAMES: &\[&str\] = &\[([^\]]*)\]/.exec(downloadsRs)?.[1],
    )
    const expected = ['con', 'prn', 'aux', 'nul']
    for (const port of ['com', 'lpt']) for (let n = 0; n <= 9; n += 1) expected.push(`${port}${n}`)
    expect(devices.sort()).toEqual(expected.sort())
    expect(downloadsRs).toMatch(/\(1\.\.=64\)\.contains\(&name\.len\(\)\)/)
  })

  it('the largest file, the download manager’s own limit', () => {
    const limit = /pub const MAX_FILE_BYTES: u64 = ([\d *]+);/.exec(downloadsRs)?.[1] ?? '0'
    const product = limit.split('*').reduce((total, factor) => total * Number(factor.trim()), 1)
    expect(product).toBe(MAX_DOWNLOAD_BYTES)
  })

  it('every extension a download or a saved copy can have', () => {
    const extensions = rustStrings(
      /pub const EXTENSIONS: &\[&str\] = &\[([^\]]*)\]/.exec(downloadsRs)?.[1],
    )
    const containers: Container[] = ['webm', 'mp4', 'm4a', 'mp3', 'ogg', 'flac', 'wav']
    const codecs: Codec[] = ['opus', 'aac', 'mp3', 'vorbis', 'flac', 'alac', 'pcm']
    const produced = new Set(['mp4'])
    for (const container of containers) {
      for (const codec of codecs) produced.add(containerExtension(container, codec))
    }
    for (const format of Object.values(DOWNLOAD_FORMATS)) {
      if (format.extension !== null) produced.add(format.extension)
    }
    expect(extensions).toEqual(expect.arrayContaining([...produced]))
  })

  it('a hidden folder for files on their way', () => {
    expect(rustConst(downloadsRs, 'PARTIAL_FOLDER')).toMatch(/^\./)
    expect(rustConst(downloadsRs, 'SAVE_SUFFIX')).toMatch(/^\./)
  })

  it('freeing what a page left open when the main window’s page loads again', () => {
    // The bridge's storage lives as long as its page: a reload leaves Rust's writers to no one.
    expect(downloadsRs).toMatch(
      /webview\.label\(\) == MAIN_WINDOW\s*&& matches!\(payload\.event\(\), PageLoadEvent::Started\)/,
    )
    expect(downloadsRs).toMatch(/let released = downloads\.release_all\(\);/)
  })
})

describe('the Spotify login plugin and the bridge agree on', () => {
  it('the plugin, its commands in build.rs and in its handler, and its event', () => {
    expect(rustConst(spotifyRs, 'PLUGIN')).toBe(SPOTIFY_PLUGIN)
    const commands = Object.values(SPOTIFY_COMMANDS)
    expect(declaredCommands('spotify')).toEqual(commands)
    expect(registeredCommands(spotifyRs)).toEqual(commands)
    expect(buildRs).toMatch(/\.plugin\("fxm-spotify", spotify\)/)
    expect(rustConst(spotifyRs, 'LOGIN_EVENT')).toBe(SPOTIFY_LOGIN_EVENT)
  })

  it('the arguments the bridge sends each command', () => {
    expect(commandArguments(spotifyRs, 'status')).toEqual([])
    expect(commandArguments(spotifyRs, 'login')).toEqual(['userAgent'])
    expect(commandArguments(spotifyRs, 'logout')).toEqual([])
    expect(commandArguments(spotifyRs, 'token')).toEqual(['params', 'userAgent'])
  })

  it('the token parameters, which Rust takes in camelCase and nothing more', () => {
    expect(spotifyRs).toMatch(
      /#\[serde\(rename_all = "camelCase", deny_unknown_fields\)\]\s*pub struct TokenParams/,
    )
    expect(structFields(spotifyRs, 'TokenParams')).toEqual([
      'reason',
      'productType',
      'totp',
      'totpServer',
      'totpVer',
    ])
    expect(read('../bridge/spotify-login.ts')).toContain(
      "const TOKEN_PARAMS = ['reason', 'productType', 'totp', 'totpServer', 'totpVer'] as const",
    )
  })

  it('the login state, in camelCase', () => {
    expect(spotifyRs).toMatch(/#\[serde\(rename_all = "camelCase"\)\]\s*pub struct LoginState/)
    expect(structFields(spotifyRs, 'LoginState')).toEqual(['loggedIn'])
  })

  it('only the token fields the Spotify provider reads', () => {
    const fields = rustStrings(
      /pub const TOKEN_FIELDS: &\[&str\] = &\[([^\]]*)\]/.exec(spotifyRs)?.[1],
    )
    expect(fields).toEqual([
      'accessToken',
      'accessTokenExpirationTimestampMs',
      'isAnonymous',
      'totpVerExpired',
    ])
    const tokenTs = read('../../../packages/sources/src/spotify/token.ts')
    expect(tokenTs).toContain(
      'const { accessToken, accessTokenExpirationTimestampMs: expiry, isAnonymous } = body',
    )
    expect(tokenTs).toContain('body.totpVerExpired')
  })

  it('the fallback browser agent and the rate limit of FXM Connect’s bridge', () => {
    const desktopTs = read('../../../packages/platform/src/desktop.ts')
    const fallback = /export const FALLBACK_BROWSER_USER_AGENT =\s*'([^']+)'/.exec(desktopTs)?.[1]
    expect(rustConst(spotifyRs, 'FALLBACK_USER_AGENT')).toBe(fallback)
    const bridgeTs = read('../../extension/src/bridge.ts')
    const max = /export const RATE_LIMIT = \{ max: (\d+), windowMs: ([\d_]+) \}/.exec(bridgeTs)
    expect(spotifyRs).toContain(`pub const RATE_LIMIT: usize = ${max?.[1]};`)
    expect(Number(max?.[2]?.replaceAll('_', ''))).toBe(60_000)
    expect(spotifyRs).toContain('pub const RATE_WINDOW: Duration = Duration::from_secs(60);')
  })
})

describe('the Spotify login window', () => {
  it('is a private window that no capability names, on https pages, opening no other window', () => {
    const label = rustConst(spotifyRs, 'LOGIN_WINDOW')
    expect(label).toBe('spotify-login')
    expect(capability.webviews).toEqual(['main'])
    expect(spotifyRs).toMatch(/\.incognito\(true\)/)
    expect(spotifyRs).toMatch(/\.on_navigation\(allowed_navigation\)/)
    expect(spotifyRs).toMatch(/\.on_new_window\(\|_, _\| NewWindowResponse::Deny\)/)
    // Read without stripping comments: the URL's `//` would read as one.
    const raw = read('../src-tauri/src/spotify_login.rs')
    expect(rustConst(raw, 'LOGIN_URL')).toMatch(/^https:\/\/accounts\.spotify\.com\//)
  })

  it('downloads nothing, grants no permission, and shows Spotify’s pages and its sign-ins', () => {
    expect(spotifyRs).toMatch(/\.on_download\(\|_, _\| false\)/)
    expect(spotifyRs).toMatch(/\.on_permission_request\(\|_, _\| PermissionResponse::Deny\)/)
    // As each page commits, not once it has loaded: a page that never finishes can't hide.
    expect(spotifyRs).toMatch(/PageLoadEvent::Started => on_page_commit\(/)
    const sites = rustStrings(
      /pub const PAGE_SITES: &\[&str\] = &\[([^\]]*)\]/.exec(spotifyRs)?.[1],
    )
    expect(sites).toContain('spotify.com')
  })

  it('keeps the login under the app’s own identifier, so the smoke build never touches it', () => {
    expect(spotifyRs).toMatch(/KeychainStore::new\(app\.config\(\)\.identifier\.clone\(\)\)/)
  })

  it('goes with the main window', () => {
    expect(spotifyRs).toMatch(
      /label == MAIN_WINDOW\s*&& let Some\(window\) = app\.get_webview_window\(LOGIN_WINDOW\)/,
    )
  })
})

describe('the app', () => {
  it('registers both plugins and grants them to the main window’s webview only', () => {
    expect(libRs).toMatch(/\.plugin\(downloads::init\(\)\)/)
    expect(libRs).toMatch(/\.plugin\(spotify_login::init\(\)\)/)
    expect(capability.permissions).toEqual(
      expect.arrayContaining([`${DOWNLOADS_PLUGIN}:default`, `${SPOTIFY_PLUGIN}:default`]),
    )
    expect(capability.webviews).toEqual(['main'])
  })
})
