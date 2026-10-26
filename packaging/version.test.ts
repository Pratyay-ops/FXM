import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  androidVersionCode,
  fitText,
  parseVersion,
  plainParagraphs,
  releaseAssetUrl,
  releasePageUrl,
  releaseSummary,
  tagOf,
} from './version.ts'

describe('versions', () => {
  it('reads x.y.z only, as make release-pr does', () => {
    expect(parseVersion('0.6.0')).toEqual({ major: 0, minor: 6, patch: 0, text: '0.6.0' })
    for (const bad of ['0.6', 'v0.6.0', '0.6.0-beta', '01.2.3', '1.2.3.4', '']) {
      expect(() => parseVersion(bad), bad).toThrow(/not a version/)
    }
  })

  it('gives the Android version code that stage 6.6’s build.gradle gives', () => {
    // apps/mobile/RELEASING.md (6.6): 0.5.0 is 5000 and 1.2.3 is 1002003; 0.0.0 gets 1.
    expect(androidVersionCode(parseVersion('0.5.0'))).toBe(5000)
    expect(androidVersionCode(parseVersion('1.2.3'))).toBe(1002003)
    expect(androidVersionCode(parseVersion('0.0.0'))).toBe(1)
    expect(androidVersionCode(parseVersion('2099.999.999'))).toBe(2099999999)
    for (const tooBig of ['2100.0.0', '0.1000.0', '0.0.1000']) {
      expect(() => androidVersionCode(parseVersion(tooBig))).toThrow(/no Android version code/)
    }
  })

  it('names a release’s tag, page and files as GitHub serves them', () => {
    const version = parseVersion('0.6.0')
    expect(tagOf(version)).toBe('v0.6.0')
    expect(releasePageUrl('https://github.com/o/r', version)).toBe(
      'https://github.com/o/r/releases/tag/v0.6.0',
    )
    expect(releaseAssetUrl('https://github.com/o/r', version, 'a.apk')).toBe(
      'https://github.com/o/r/releases/download/v0.6.0/a.apk',
    )
  })
})

describe('release summaries', () => {
  it('turn Markdown into plain paragraphs', () => {
    const markdown = [
      '<!-- a comment -->',
      'FXM 0.6.0 brings the **Android app** and [the desktop app](https://example.org).',
      'It plays `Opus`.',
      '',
      '## What works',
      '',
      '- Search _and_ play',
      '- Lyrics',
    ].join('\n')
    expect(plainParagraphs(markdown)).toEqual([
      'FXM 0.6.0 brings the Android app and the desktop app. It plays Opus.',
      'What works',
      'Search and play',
      'Lyrics',
    ])
  })

  it('refuse a summary that is missing or still a draft', () => {
    const root = mkdtempSync(join(tmpdir(), 'fxm-summary-'))
    try {
      mkdirSync(join(root, 'docs', 'releases'), { recursive: true })
      expect(() => releaseSummary(parseVersion('0.6.0'), root)).toThrow(/missing/)
      writeFileSync(join(root, 'docs', 'releases', 'v0.6.0.md'), '<!-- draft: check it -->\nText\n')
      expect(() => releaseSummary(parseVersion('0.6.0'), root)).toThrow(/draft/)
      writeFileSync(join(root, 'docs', 'releases', 'v0.6.0.md'), 'FXM 0.6.0 is out.\n')
      expect(releaseSummary(parseVersion('0.6.0'), root)).toEqual(['FXM 0.6.0 is out.'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('cut text to a limit at a sentence’s end where one ends in time', () => {
    expect(fitText('Short.', 10)).toBe('Short.')
    expect(fitText('One sentence here. Two sentences here.', 30)).toBe('One sentence here.')
    const cut = fitText('word '.repeat(50).trim(), 21)
    expect(cut.length).toBeLessThanOrEqual(21)
    expect(cut).toMatch(/…$/)
  })
})
