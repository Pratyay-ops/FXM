/**
 * Live check of what FXM's site publishes for the desktop and Android apps, only with
 * `FXM_LIVE=1` (`make live-smoke`): the signed YouTube module and config verify against the keys
 * compiled into this build, their bytes match their signatures, their versions are at least the
 * bundled ones and not revoked, and the config reads as a config. Four requests to the site at
 * most, none to YouTube. It is skipped while `update-keys.json` holds only the placeholder:
 * nothing can be published before the owner creates the keys.
 *
 * It never runs the downloaded module. The owner's Mac runs this test unattended every day
 * (docs/DEVELOPMENT.md), and code imported here would run with the owner's rights: their files,
 * keys and GitHub credentials. The config is only parsed, as data.
 */
import {
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_CONFIG_SCHEMA,
  YOUTUBE_MODULE_API,
  YOUTUBE_MODULE_FILE,
  YOUTUBE_MODULE_KIND,
  youtubeModule,
} from '@fxm/sources/youtube/module'
import { describe, expect, it } from 'vitest'
import { fromUtf8 } from './encoding.ts'
import { DEFAULT_CODE_MAX_BYTES, DEFAULT_JSON_MAX_BYTES } from './format.ts'
import { UPDATE_SIGNING_KEYS, UPDATE_SIGNING_READY } from './keys.ts'
import { DEFAULT_UPDATE_BASE_URLS } from './updater.ts'
import {
  type ArtifactExpectation,
  checkArtifactBytes,
  createSignatureVerifier,
  verifySignatureFile,
} from './verify.ts'

const live =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.FXM_LIVE === '1'

async function download(url: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error' })
  expect(response.ok, `${url}: HTTP ${response.status}`).toBe(true)
  const bytes = new Uint8Array(await response.arrayBuffer())
  expect(bytes.length).toBeLessThanOrEqual(maxBytes)
  return bytes
}

describe.skipIf(!live || !UPDATE_SIGNING_READY)('FXM’s signed updates, live', () => {
  const base = DEFAULT_UPDATE_BASE_URLS[0] ?? ''
  const artifacts: { expected: ArtifactExpectation; bundled: number }[] = [
    {
      expected: {
        kind: YOUTUBE_MODULE_KIND,
        file: YOUTUBE_MODULE_FILE,
        api: YOUTUBE_MODULE_API,
        maxBytes: DEFAULT_CODE_MAX_BYTES,
      },
      bundled: youtubeModule.version,
    },
    {
      expected: {
        kind: YOUTUBE_CONFIG_KIND,
        file: YOUTUBE_CONFIG_FILE,
        api: YOUTUBE_CONFIG_SCHEMA,
        maxBytes: DEFAULT_JSON_MAX_BYTES,
      },
      bundled: youtubeModule.checkConfig(youtubeModule.config),
    },
  ]

  it.each(artifacts)(
    'publishes $expected.file, signed by a key this build trusts',
    async ({ expected, bundled }) => {
      const envelope = await download(`${base}${expected.file}.sig`, 4096)
      const verdict = await verifySignatureFile(
        envelope,
        expected,
        UPDATE_SIGNING_KEYS.keys,
        createSignatureVerifier(),
      )
      if (!verdict.ok) throw new Error(`${expected.file}: ${verdict.failure}: ${verdict.message}`)
      const { statement } = verdict
      expect(statement.version).toBeGreaterThanOrEqual(bundled)
      expect(UPDATE_SIGNING_KEYS.revoked[expected.kind] ?? []).not.toContain(statement.version)
      const bytes = await download(`${base}${expected.file}`, statement.size)
      expect(checkArtifactBytes(bytes, statement)).toBeUndefined()
      if (expected.kind === YOUTUBE_CONFIG_KIND) {
        expect(youtubeModule.checkConfig(JSON.parse(fromUtf8(bytes)))).toBe(statement.version)
      }
    },
    60_000,
  )
})
