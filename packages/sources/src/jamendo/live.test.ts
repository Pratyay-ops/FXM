/**
 * Live checks against api.jamendo.com, four requests in all. They need a client_id of your own
 * and run only with both variables set:
 *
 * ```sh
 * FXM_LIVE=1 FXM_JAMENDO_CLIENT_ID=<your client_id> \
 *   scripts/run.sh pnpm exec vitest run packages/sources/src/jamendo/live.test.ts
 * ```
 *
 * Register one at https://devportal.jamendo.com. Never commit it.
 */

import { DEFAULT_QUALITY_PREFS, type ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createJamendoSource } from './provider'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const clientId = env?.FXM_JAMENDO_CLIENT_ID?.trim() ?? ''
const live = env?.FXM_LIVE === '1' && clientId !== ''

describe.skipIf(!live)('Jamendo, live', { timeout: 60_000 }, () => {
  const jamendo = createJamendoSource({ userClientId: clientId })
  const ctx: ProviderContext = {
    fetch: globalThis.fetch.bind(globalThis),
    platform: 'web',
    capabilities: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
    mode: 'music',
  }

  it('finds tracks and resolves one to a lossless FLAC stream', async () => {
    const results = await jamendo.search('funk', { types: ['track'], limit: 3 }, ctx)
    const [track] = results.tracks?.items ?? []
    expect(track?.source).toBe('jamendo')
    expect(jamendo.access()).toEqual({ status: 'ready', client: 'user' })
    const ref = track?.id.split(':')[2] ?? ''
    const options = await jamendo.resolve(
      { source: 'jamendo', ref, kind: 'song', title: '', artists: [], confidence: 1, evidence: [] },
      ctx,
      DEFAULT_QUALITY_PREFS,
    )
    const [best] = options
    expect(best).toMatchObject({ codec: 'flac', tier: 'lossless' })
    const head = await fetch(best?.url ?? '', {
      headers: { Range: 'bytes=0-41', Origin: 'https://fxmusic.pages.dev' },
    })
    const bytes = new Uint8Array(await head.arrayBuffer())
    expect(head.status).toBe(206)
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('fLaC')
    expect(head.headers.get('access-control-allow-origin')).not.toBeNull()
  })

  it('lets any web page read its answers when a client_id is sent', async () => {
    const response = await fetch(
      `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(clientId)}&format=json&limit=1`,
      { headers: { Origin: 'https://fxmusic.pages.dev' } },
    )
    await response.body?.cancel()
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})
