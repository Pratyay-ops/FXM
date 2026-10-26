import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { DEB_ARCHES, linuxDeb } from '../artifacts.ts'
import { EXAMPLE_SHA256, EXAMPLE_VERSION } from '../files.ts'
import { FLATPAK_ID } from '../listing.ts'
import { parseVersion, REPO_ROOT } from '../version.ts'
import {
  BRANDING,
  DESKTOP_FILE,
  desktopEntry,
  ICON_SOURCE,
  METAINFO_FILE,
  metainfoXml,
  xmlText,
} from './appdata.ts'
import {
  BINARY_PATH,
  FINISH_ARGS,
  flatpakManifest,
  LOCAL_FILES,
  mprisNamePrefix,
  RUNTIME,
  SHARED_MODULES,
} from './manifest.ts'

/**
 * Checks that XML is well formed, as far as these files go: every tag closes in order, and text
 * holds no raw `&` or `<`. Returns the element names in document order.
 */
function elements(xml: string): string[] {
  const names: string[] = []
  const open: string[] = []
  const body = xml.replace(/<\?xml[^?]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '')
  for (const match of body.matchAll(/<(\/?)([a-z_]+)([^>]*?)(\/?)>|&(?!amp;|lt;|gt;)/g)) {
    if (match[0].startsWith('&')) throw new Error(`a raw & at ${match.index}`)
    const [, closing, name = '', , selfClosing] = match
    if (closing) {
      if (open.pop() !== name) throw new Error(`</${name}> closes nothing open`)
    } else {
      names.push(name)
      if (!selfClosing) open.push(name)
    }
  }
  if (open.length > 0) throw new Error(`<${open.join('>, <')}> never closes`)
  return names
}

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8')

describe('the AppStream metainfo', () => {
  const xml = read(METAINFO_FILE)

  it('is well formed, and names the app by its Flatpak ID', () => {
    const names = elements(xml)
    expect(names[0]).toBe('component')
    expect(xml).toContain('<component type="desktop-application">')
    expect(xml).toContain(`<id>${FLATPAK_ID}</id>`)
    expect(xml).toContain(`<launchable type="desktop-id">${FLATPAK_ID}.desktop</launchable>`)
    expect(METAINFO_FILE).toBe(`packaging/flatpak/${FLATPAK_ID}.metainfo.xml`)
  })

  it('has what Flathub requires: licences, developer, description, homepage, rating', () => {
    for (const element of [
      '<metadata_license>CC0-1.0</metadata_license>',
      '<project_license>Apache-2.0</project_license>',
      '<developer id="io.github.pratyay_ops">',
      '<url type="homepage">https://fxmusic.pages.dev</url>',
      '<url type="vcs-browser">https://github.com/Pratyay-ops/FXM</url>',
      '<content_rating type="oars-1.1"/>',
    ]) {
      expect(xml).toContain(element)
    }
    expect(xml).toContain(`scheme_preference="light">${BRANDING.light}<`)
    expect(xml).toContain(`scheme_preference="dark">${BRANDING.dark}<`)
    // The repository's copy names no release; a release's Flatpak gets a copy that does.
    expect(xml).not.toContain('<release')
    expect(xml).toBe(metainfoXml())
  })

  it('names a release, with its page and notes, in the copy for that release', () => {
    const generated = metainfoXml({
      version: parseVersion('0.6.0'),
      date: '2026-12-01',
      note: 'Android & desktop <apps>',
    })
    elements(generated)
    expect(generated).toMatch(
      /<releases>\s*<release version="0.6.0" date="2026-12-01">\s*<url type="details">https:\/\/github.com\/Pratyay-ops\/FXM\/releases\/tag\/v0.6.0<\/url>\s*<description>\s*<p>Android &amp; desktop &lt;apps&gt;<\/p>/,
    )
    const withoutNote = metainfoXml({ version: parseVersion('0.6.0'), date: '2026-12-01' })
    elements(withoutNote)
    expect(withoutNote).not.toContain('<description>\n        <p>')
    expect(xmlText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })
})

describe('the desktop entry', () => {
  it('launches the app under its Flatpak ID and icon', () => {
    const entry = read(DESKTOP_FILE)
    expect(entry).toBe(desktopEntry())
    const keys = Object.fromEntries(
      entry
        .split('\n')
        .slice(1)
        .filter((line) => line.includes('='))
        .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]),
    )
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true)
    expect(keys).toMatchObject({
      Type: 'Application',
      Name: 'FXM',
      Exec: 'fxm',
      Icon: FLATPAK_ID,
      Categories: 'AudioVideo;Audio;Player;',
    })
    expect(DESKTOP_FILE).toBe(`packaging/flatpak/${FLATPAK_ID}.desktop`)
    expect(existsSync(join(REPO_ROOT, ICON_SOURCE))).toBe(true)
  })
})

describe('the local Flatpak manifest', () => {
  const version = parseVersion('0.6.0')
  const debSha256 = { x86_64: 'a'.repeat(64), aarch64: 'b'.repeat(64) }
  const manifest = parse(flatpakManifest({ version, debSha256 }))

  it('runs on the latest GNOME runtime, with the app’s binary as its command', () => {
    expect(manifest).toMatchObject({
      id: FLATPAK_ID,
      runtime: RUNTIME.name,
      'runtime-version': RUNTIME.version,
      sdk: RUNTIME.sdk,
      command: 'fxm',
    })
    // Quoted: an unquoted 51 would be a number.
    expect(typeof manifest['runtime-version']).toBe('string')
  })

  it('asks for the network, sound and display, and no files, devices or host access', () => {
    expect(manifest['finish-args']).toEqual([...FINISH_ARGS])
    for (const arg of FINISH_ARGS) {
      expect(arg).not.toMatch(
        /--filesystem|--device=all|--socket=session-bus|--talk-name=org\.freedesktop\.Flatpak/,
      )
    }
    expect(FINISH_ARGS).toContain('--share=network')
    expect(FINISH_ARGS).toContain('--socket=pulseaudio')
  })

  it('owns only the media control names of its own binary, none of other WebKitGTK apps', () => {
    // WebKitGTK names an app without a GTK application ID after the SHA-256 of its executable's
    // path, which is always /app/bin/fxm in the Flatpak.
    expect(BINARY_PATH).toBe('/app/bin/fxm')
    expect(mprisNamePrefix()).toBe(
      'org.mpris.MediaPlayer2.org.webkit.app-26bedc89bd659ca1ee452a330e1e6b89f42e9728c63e830c9ec8126988e86778',
    )
    expect(FINISH_ARGS).toContain(`--own-name=${mprisNamePrefix()}.*`)
    const names = FINISH_ARGS.filter((arg) => arg.startsWith('--own-name='))
    expect(names).toEqual([
      '--own-name=io.github.pratyayops.fxm.SingleInstance',
      `--own-name=${mprisNamePrefix()}.*`,
    ])
    // The binary the manifest installs and runs is the one the name is made from.
    expect(flatpakManifest({ version, debSha256 })).toContain(
      `install -Dm755 usr/bin/fxm ${BINARY_PATH}`,
    )
    expect(mprisNamePrefix('/usr/bin/fxm')).not.toBe(mprisNamePrefix())
  })

  it('builds the tray icon’s library with Flathub’s shared module', () => {
    // The GNOME runtime has none, and the tray (libappindicator-sys) panics without one.
    expect(manifest.modules[0]).toBe(SHARED_MODULES.appIndicator)
    expect(SHARED_MODULES.appIndicator.startsWith(`${SHARED_MODULES.folder}/`)).toBe(true)
    expect(SHARED_MODULES.commit).toMatch(/^[\da-f]{40}$/)
    const text = flatpakManifest({ version, debSha256 })
    expect(text).toContain(`${SHARED_MODULES.url} at ${SHARED_MODULES.commit}`)
    // The README's build steps check out the same commit.
    expect(read('packaging/flatpak/README.md')).toContain(
      `git -C shared-modules checkout ${SHARED_MODULES.commit}`,
    )
  })

  it('shows in its README what it writes for an example release', () => {
    const readme = read('packaging/flatpak/README.md')
    const example = flatpakManifest({
      version: EXAMPLE_VERSION,
      debSha256: { x86_64: EXAMPLE_SHA256, aarch64: EXAMPLE_SHA256 },
    })
    expect(readme).toContain(`\`\`\`yaml\n${example}\`\`\``)
    expect(readme).toContain(`What \`channels flatpak ${EXAMPLE_VERSION.text}\` writes`)
    expect(EXAMPLE_SHA256).toMatch(/^0{64}$/)
  })

  it('repackages each architecture’s .deb from the release, by checksum, offline', () => {
    const module = (manifest.modules as unknown[])[1] as {
      name: string
      sources: Record<string, unknown>[]
      'build-commands': string[]
      'build-options'?: unknown
    }
    expect(module.name).toBe('fxm')
    // The binary, and the resources Tauri looks for next to it (the notices of stage 7.5).
    expect(module['build-commands']).toEqual(
      expect.arrayContaining([
        'install -Dm755 usr/bin/fxm /app/bin/fxm',
        'if [ -d usr/lib/FXM ]; then mkdir -p /app/lib && cp -R usr/lib/FXM /app/lib/; fi',
      ]),
    )
    const debs = module.sources.filter((source) => typeof source.url === 'string')
    expect(debs).toEqual(
      DEB_ARCHES.map((arch) => ({
        type: 'file',
        url: `https://github.com/Pratyay-ops/FXM/releases/download/v0.6.0/${linuxDeb(version, arch)}`,
        sha256: debSha256[arch],
        'dest-filename': 'fxm.deb',
        'only-arches': [arch],
      })),
    )
    const files = module.sources.filter((source) => typeof source.path === 'string')
    expect(files.map((source) => source.path)).toEqual(Object.values(LOCAL_FILES))
    // Flathub builds without the network: nothing asks for it.
    expect(module['build-options']).toBeUndefined()
    expect(() => flatpakManifest({ version, debSha256: { ...debSha256, x86_64: 'nope' } })).toThrow(
      /SHA-256/,
    )
  })
})
