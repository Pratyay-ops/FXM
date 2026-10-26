import { describe, expect, it } from 'vitest'
import { FDROID_BUILD_NOTE, fullDescription } from './fdroid/fastlane.ts'
import {
  description,
  FLATPAK_ID,
  GITHUB_OWNER,
  NON_FREE_NET_REASON,
  NOTICE,
  REPO_URL,
  SUMMARY,
  TAGLINE,
} from './listing.ts'
import { wingetDescription } from './winget/manifest.ts'

/** Every public text the listings carry. */
const TEXTS = [
  SUMMARY,
  TAGLINE,
  NOTICE,
  NON_FREE_NET_REASON,
  FDROID_BUILD_NOTE,
  fullDescription(),
  wingetDescription(),
  ...(['android', 'desktop'] as const).flatMap((platform) => {
    const { intro, features, paragraphs } = description(platform)
    return [intro, ...features, ...paragraphs]
  }),
]

describe('the listing texts', () => {
  it('give a summary that Flathub and F-Droid take as it is', () => {
    // Flathub: 10 to 25 characters ideally, 35 at most, no full stop, no article first, no
    // "free and open source", not the name again. F-Droid: at most 80, no trailing full stop.
    expect(SUMMARY.length).toBeGreaterThanOrEqual(10)
    expect(SUMMARY.length).toBeLessThanOrEqual(25)
    expect(SUMMARY).not.toMatch(/\.$|^(a|an|the) |free|open.source|FXM/i)
    expect(SUMMARY).toMatch(/^[A-Z][a-z]/)
  })

  it('keep the NonFreeNet reason on one line after `fdroid rewritemeta`', () => {
    // rewritemeta wraps lines at 80 columns, and the reason follows "    en-US: ".
    expect(`    en-US: ${NON_FREE_NET_REASON}`.length).toBeLessThanOrEqual(80)
    expect(NON_FREE_NET_REASON).toMatch(/YouTube Music/)
    expect(NON_FREE_NET_REASON).toMatch(/Spotify/)
  })

  it('name services in plain words only, never with lookalike names or endorsement', () => {
    for (const text of TEXTS) {
      // LEGAL.md: no "Spot…" or "…Tube" names of FXM's own, no partnership words.
      expect(text.replaceAll('Spotify', '')).not.toMatch(/spot\w*/i)
      expect(text.replaceAll('YouTube', '')).not.toMatch(/\w*tube\b/i)
      expect(text).not.toMatch(/\b(official|partner|certified|ad-free|ad free)\b/i)
      expect(text.replace(NOTICE, '')).not.toMatch(/endorsed|affiliated/i)
    }
  })

  it('carry the non-affiliation notice with every description that names the services', () => {
    expect(NOTICE).toMatch(/not affiliated with or endorsed by YouTube, Google or Spotify/)
    expect(fullDescription()).toContain(NOTICE)
    expect(wingetDescription()).toContain(NOTICE)
    for (const platform of ['android', 'desktop'] as const) {
      expect(description(platform).paragraphs).toContain(NOTICE)
    }
  })

  it('keep the feature lists short enough for software centres', () => {
    // Flathub's quality guidelines: lists of more than 10 items are hard to scan.
    for (const platform of ['android', 'desktop'] as const) {
      expect(description(platform).features.length).toBeLessThanOrEqual(10)
    }
  })

  it('tell F-Droid users what their build does differently', () => {
    expect(FDROID_BUILD_NOTE).toMatch(/F-Droid updates it/)
    expect(FDROID_BUILD_NOTE).toMatch(/takes the settings, which are data/)
    expect(FDROID_BUILD_NOTE).toMatch(/code only after you turn that on in Settings → Sources/)
    expect(fullDescription()).toContain(FDROID_BUILD_NOTE)
  })

  it('derive the Flatpak ID from the repository, as Flathub checks', () => {
    // Flathub demangles io.github.<owner>.<repo>: an underscore stands for a dash.
    const [, , owner, repo] = FLATPAK_ID.split('.') as [string, string, string, string]
    expect(owner.replaceAll('_', '-')).toBe(GITHUB_OWNER.toLowerCase())
    expect(`https://github.com/${owner.replaceAll('_', '-')}/${repo}`.toLowerCase()).toBe(
      REPO_URL.toLowerCase(),
    )
    expect(owner).toBe(owner.toLowerCase())
  })
})
