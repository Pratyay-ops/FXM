/**
 * Live check, only with FXM_LIVE=1 (one request to YouTube Music): InnerTube accepts the
 * CORS-simple shape that every transport sends, from a youtubei.js-style request with JSON
 * headers. Advisory in CI, where datacenter IPs may meet bot checks.
 */
import { describe, expect, it } from 'vitest'
import { createNodeTransport } from './node'

const live =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.FXM_LIVE === '1'

describe.skipIf(!live)('InnerTube, live', () => {
  it('answers a search sent in the CORS-simple shape', async () => {
    const transport = createNodeTransport()
    const response = await transport.fetch('https://music.youtube.com/youtubei/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '67',
        'X-YouTube-Client-Version': '1.20251020.01.00',
      },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', hl: 'en', gl: 'US' } },
        query: 'radiohead creep',
      }),
    })
    expect(response.status).toBe(200)
    const json = (await response.json()) as { contents?: unknown }
    expect(json.contents).toBeDefined()
    expect(transport.budget.snapshot().used).toBe(1)
  }, 20_000)
})
