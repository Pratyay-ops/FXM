import { describe, expect, it } from 'vitest'
import type { JsonRecord } from '../../json'
import { cipheredUrlOf, decipherUrls } from './decipher'
import { createInProcessEvaluator } from './fixtures/platform-evaluator'
import { FAKE_SIGNATURE } from './fixtures/sanitize'
import {
  ADVANCED_FIXTURES,
  decipheredSignature,
  FAKE_PLAYER_ID,
  FAKE_SIGNATURE_TIMESTAMP,
  fakePlayerScript,
  transformedN,
} from './fixtures/testing'
import type { PlayerScript } from './player-script'

const player = (options: { brokenN?: boolean } = {}): PlayerScript => ({
  playerId: FAKE_PLAYER_ID,
  signatureTimestamp: FAKE_SIGNATURE_TIMESTAMP,
  script: fakePlayerScript(options),
  checkedAt: 0,
})

const tvFormats = ADVANCED_FIXTURES['tv-samsung-song'].streamingData.adaptiveFormats as JsonRecord[]
const opus = tvFormats.find((format) => format.itag === 251) as JsonRecord

describe('deciphering', () => {
  it("reads a format's signatureCipher, or a plain URL with n", () => {
    const entry = cipheredUrlOf(opus)
    expect(entry).toMatchObject({ s: FAKE_SIGNATURE, sp: 'sig', n: 'fxm-n-251' })
    expect(new URL(entry?.url ?? '').searchParams.get('itag')).toBe('251')
    expect(
      cipheredUrlOf({ url: 'https://rr1---sn-x.googlevideo.com/videoplayback?n=abc' }),
    ).toEqual({
      url: 'https://rr1---sn-x.googlevideo.com/videoplayback?n=abc',
      n: 'abc',
    })
    expect(
      cipheredUrlOf({ signatureCipher: 'sp=sig&url=https%3A%2F%2Fx.googlevideo.com%2F' }),
    ).toBeUndefined()
    expect(cipheredUrlOf({ url: 'not a url' })).toBeUndefined()
  })

  it('deciphers every URL of an answer in one evaluator call, defining the extract once', async () => {
    const evaluator = createInProcessEvaluator()
    const entries = tvFormats.flatMap((format) => {
      const entry = cipheredUrlOf(format)
      return entry === undefined ? [] : [entry]
    })
    const urls = await decipherUrls(evaluator, player(), entries)
    expect(urls).toHaveLength(entries.length)
    const deciphered = new URL(urls[entries.findIndex((entry) => entry.n === 'fxm-n-251')] ?? '')
    expect(deciphered.searchParams.get('sig')).toBe(decipheredSignature(FAKE_SIGNATURE))
    expect(deciphered.searchParams.get('n')).toBe(transformedN('fxm-n-251'))
    expect(deciphered.searchParams.get('itag')).toBe('251')
    await decipherUrls(evaluator, player(), entries.slice(0, 1))
    expect(evaluator.requests.map((request) => request.method)).toEqual([
      'define',
      'invoke',
      'invoke',
    ])
    expect(evaluator.requests[0]).toMatchObject({ params: { key: `player:${FAKE_PLAYER_ID}` } })
  })

  it('leaves URLs that need nothing as they are, without calling the evaluator', async () => {
    const evaluator = createInProcessEvaluator()
    const plain = { url: 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=251' }
    expect(await decipherUrls(evaluator, player(), [plain])).toEqual([plain.url])
    expect(evaluator.requests).toHaveLength(0)
  })

  it("fails with Parse when the player's n function fails inside", async () => {
    const evaluator = createInProcessEvaluator()
    const entry = cipheredUrlOf(opus)
    await expect(
      decipherUrls(evaluator, player({ brokenN: true }), entry === undefined ? [] : [entry]),
    ).rejects.toMatchObject({ code: 'Parse', message: expect.stringContaining('transform n') })
  })

  it('fails with Parse when the extract defines no function', async () => {
    const evaluator = createInProcessEvaluator()
    const empty = { ...player(), script: 'const exportedVars = {}' }
    const entry = cipheredUrlOf(opus)
    await expect(
      decipherUrls(evaluator, empty, entry === undefined ? [] : [entry]),
    ).rejects.toMatchObject({ code: 'Parse', evaluatorCode: 'script-error' })
  })
})
