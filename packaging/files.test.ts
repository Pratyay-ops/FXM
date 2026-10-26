import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FASTLANE_DIR, FASTLANE_ICON, FASTLANE_LIMITS } from './fdroid/fastlane.ts'
import { readVersionFile, VERSION_FILE } from './fdroid/recipe.ts'
import { staleFiles } from './files.ts'
import { androidVersionCode, productVersion, REPO_ROOT } from './version.ts'

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8')

describe('the generated files', () => {
  it('match listing.ts: run `channels sync` after changing it', () => {
    expect(staleFiles()).toEqual([])
  })

  it('keep F-Droid’s texts within its limits', () => {
    // F-Droid's "All About Descriptions, Graphics, and Screenshots" (read 2026-10-26).
    const title = read(`${FASTLANE_DIR}/title.txt`).trim()
    const short = read(`${FASTLANE_DIR}/short_description.txt`).trim()
    const full = read(`${FASTLANE_DIR}/full_description.txt`).trim()
    expect(title.length).toBeLessThanOrEqual(FASTLANE_LIMITS.title)
    expect(short.length).toBeLessThanOrEqual(FASTLANE_LIMITS.short)
    expect(short).not.toMatch(/\.$/)
    expect(full.length).toBeLessThanOrEqual(FASTLANE_LIMITS.full)
    // F-Droid renders a subset of HTML and forbids the rest; the description has none.
    expect(full).not.toMatch(/<[a-z]/i)
  })

  it('give F-Droid the app’s 512 px icon', () => {
    const icon = readFileSync(join(REPO_ROOT, FASTLANE_ICON.to))
    expect(icon.equals(readFileSync(join(REPO_ROOT, FASTLANE_ICON.from)))).toBe(true)
    // A PNG of 512 × 512: the width and height sit in the IHDR chunk.
    expect(icon.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect([icon.readUInt32BE(16), icon.readUInt32BE(20)]).toEqual([512, 512])
  })

  it('keep each release’s changelog within 500 characters, named by its version code', () => {
    let changelogs: string[] = []
    try {
      changelogs = readdirSync(join(REPO_ROOT, FASTLANE_DIR, 'changelogs'))
    } catch {
      // None written yet: `channels changelog <x.y.z>` writes one.
    }
    for (const changelog of changelogs) {
      expect(changelog).toMatch(/^[1-9]\d*\.txt$/)
      expect(read(`${FASTLANE_DIR}/changelogs/${changelog}`).trim().length).toBeLessThanOrEqual(
        FASTLANE_LIMITS.changelog,
      )
    }
  })

  it('name FXM’s version in version.txt, for F-Droid’s update check', () => {
    // scripts/release-version.sh sets it with every other version, in the release commit.
    const version = productVersion()
    expect(readVersionFile(read(VERSION_FILE))).toEqual({
      name: version.text,
      code: androidVersionCode(version),
    })
  })
})
