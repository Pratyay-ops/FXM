/**
 * The files this package keeps in the repository from ./listing.ts: F-Droid's store listing
 * (fastlane) and the Linux desktop app's metainfo and desktop entry. `channels sync` writes them,
 * and files.test.ts checks that the committed copies match, so they never drift from the listing.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FASTLANE_ICON, fastlaneTexts } from './fdroid/fastlane.ts'
import { DESKTOP_FILE, desktopEntry, METAINFO_FILE, metainfoXml } from './flatpak/appdata.ts'
import { REPO_ROOT } from './version.ts'

/** Every generated file, by path from the repository's root, with its exact contents. */
export function generatedFiles(root: string = REPO_ROOT): Map<string, string | Uint8Array> {
  const files = new Map<string, string | Uint8Array>(fastlaneTexts())
  files.set(FASTLANE_ICON.to, new Uint8Array(readFileSync(join(root, FASTLANE_ICON.from))))
  files.set(METAINFO_FILE, metainfoXml())
  files.set(DESKTOP_FILE, desktopEntry())
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
