/**
 * The files this package keeps in the repository from its generators: F-Droid's store listing
 * (fastlane) and the Linux desktop app's metainfo and desktop entry, from ./listing.ts, and the
 * blocks of the READMEs that show what the generators write: F-Droid's recipe and the Flatpak
 * manifest for an example release, and Obtainium's links. `channels sync` writes them, and
 * files.test.ts checks that the committed copies match, so they never drift from the generators.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEB_ARCHES, type DebArch } from './artifacts.ts'
import { FASTLANE_ICON, fastlaneTexts } from './fdroid/fastlane.ts'
import { defaultCommit, fdroidRecipe } from './fdroid/recipe.ts'
import { DESKTOP_FILE, desktopEntry, METAINFO_FILE, metainfoXml } from './flatpak/appdata.ts'
import { flatpakManifest } from './flatpak/manifest.ts'
import { linksTable, pinnedCertificate } from './obtainium/obtainium.ts'
import { parseVersion, REPO_ROOT } from './version.ts'

/** The release the READMEs' examples are written for. */
export const EXAMPLE_VERSION = parseVersion('1.2.3')

/**
 * The checksums in the READMEs' examples: placeholders, where the channels workflow writes each
 * file's from the release's SHA256SUMS.
 */
export const EXAMPLE_SHA256 = '0'.repeat(64)

/** Where stage 6.6 pins the SHA-256 of FXM's release signing certificate. */
export const RELEASE_CERTIFICATE_FILE = 'apps/mobile/release-certificate.txt'

/** The certificate apps/mobile/release-certificate.txt pins, or `undefined` while it pins none. */
export function pinnedReleaseCertificate(root: string = REPO_ROOT): string | undefined {
  const file = join(root, RELEASE_CERTIFICATE_FILE)
  return pinnedCertificate(existsSync(file) ? readFileSync(file, 'utf8') : undefined)
}

/** The comments around a README block that `channels sync` writes. */
export function blockMarkers(name: string): { start: string; end: string } {
  return { start: `<!-- channels sync: ${name} -->`, end: `<!-- /channels sync: ${name} -->` }
}

/** A fenced code block. */
function fenced(language: string, text: string): string {
  return `\`\`\`${language}\n${text.trimEnd()}\n\`\`\``
}

/** Each README's generated blocks, by path from the repository's root, then by block name. */
export function readmeBlocks(root: string = REPO_ROOT): Map<string, Record<string, string>> {
  const certificate = pinnedReleaseCertificate(root)
  const debSha256 = Object.fromEntries(DEB_ARCHES.map((arch) => [arch, EXAMPLE_SHA256])) as Record<
    DebArch,
    string
  >
  return new Map([
    [
      'packaging/fdroid/README.md',
      {
        recipe: fenced(
          'yaml',
          fdroidRecipe({ version: EXAMPLE_VERSION, commit: defaultCommit(EXAMPLE_VERSION) }),
        ),
      },
    ],
    [
      'packaging/flatpak/README.md',
      { manifest: fenced('yaml', flatpakManifest({ version: EXAMPLE_VERSION, debSha256 })) },
    ],
    [
      'packaging/obtainium/README.md',
      { links: linksTable(certificate === undefined ? {} : { certificate }) },
    ],
  ])
}

/**
 * `text` with each block in `blocks` written between its markers ({@link blockMarkers}). Throws
 * when `path`'s text lacks a block's markers.
 */
export function fillBlocks(
  text: string,
  blocks: Readonly<Record<string, string>>,
  path: string,
): string {
  let filled = text
  for (const [name, contents] of Object.entries(blocks)) {
    const { start, end } = blockMarkers(name)
    const from = filled.indexOf(start)
    const to = filled.indexOf(end)
    if (from < 0 || to < from) throw new Error(`${path} has no block ${start} … ${end}`)
    filled = `${filled.slice(0, from + start.length)}\n\n${contents}\n\n${filled.slice(to)}`
  }
  return filled
}

/** Every generated file, by path from the repository's root, with its exact contents. */
export function generatedFiles(root: string = REPO_ROOT): Map<string, string | Uint8Array> {
  const files = new Map<string, string | Uint8Array>(fastlaneTexts())
  files.set(FASTLANE_ICON.to, new Uint8Array(readFileSync(join(root, FASTLANE_ICON.from))))
  files.set(METAINFO_FILE, metainfoXml())
  files.set(DESKTOP_FILE, desktopEntry())
  for (const [path, blocks] of readmeBlocks(root)) {
    files.set(path, fillBlocks(readFileSync(join(root, path), 'utf8'), blocks, path))
  }
  return files
}

/** Whether two file contents are equal, byte for byte. */
export function sameContents(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const left = typeof a === 'string' ? new TextEncoder().encode(a) : a
  const right = typeof b === 'string' ? new TextEncoder().encode(b) : b
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

/** The generated files whose committed copy is missing or differs. */
export function staleFiles(root: string = REPO_ROOT): string[] {
  return [...generatedFiles(root)]
    .filter(([path, contents]) => {
      const file = join(root, path)
      return !existsSync(file) || !sameContents(new Uint8Array(readFileSync(file)), contents)
    })
    .map(([path]) => path)
}
