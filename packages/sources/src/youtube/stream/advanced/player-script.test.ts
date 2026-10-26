import { describe, expect, it } from 'vitest'
import { context, fakeInnerTube } from '../../fixtures/testing'
import {
  FAKE_PLAYER_ID,
  FAKE_SIGNATURE_TIMESTAMP,
  fakeExtractor,
  iframeApi,
  onIframeApi,
  onPlayerScript,
} from './fixtures/testing'
import { IFRAME_API_URL, type PlayerScript, PlayerScripts, playerIdOf } from './player-script'

const HOUR = 3_600_000

function setup(options: { playerId?: string; store?: { value?: unknown } } = {}) {
  let playerId = options.playerId ?? FAKE_PLAYER_ID
  const { fetch, requests } = fakeInnerTube(
    (request) =>
      request.url.href === IFRAME_API_URL ? new Response(iframeApi(playerId)) : undefined,
    onPlayerScript(),
  )
  const { extract, extracted } = fakeExtractor()
  let time = 1_000_000
  const saved: PlayerScript[] = []
  const scripts = new PlayerScripts({
    extract,
    now: () => time,
    ...(options.store === undefined
      ? {}
      : {
          store: {
            load: () => options.store?.value,
            save: (script) => {
              saved.push(script)
            },
          },
        }),
  })
  return {
    scripts,
    ctx: context(fetch),
    requests,
    extracted,
    saved,
    advance: (ms: number) => {
      time += ms
    },
    setPlayer: (id: string) => {
      playerId = id
    },
  }
}

describe('the player script', () => {
  it("finds the player's ID in iframe_api", () => {
    expect(playerIdOf(iframeApi('cbcfbf2f'))).toBe('cbcfbf2f')
    expect(playerIdOf('no player here')).toBeUndefined()
    expect(playerIdOf(iframeApi('NOT-HEX'))).toBeUndefined()
  })

  it('fetches the ID, then the script, and extracts the functions once', async () => {
    const { scripts, ctx, requests, extracted } = setup()
    const script = await scripts.current(ctx)
    expect(script).toMatchObject({
      playerId: FAKE_PLAYER_ID,
      signatureTimestamp: FAKE_SIGNATURE_TIMESTAMP,
    })
    expect(script.script).toContain('nsigFunction')
    expect(requests.map((request) => request.url.href)).toEqual([
      IFRAME_API_URL,
      `https://www.youtube.com/s/player/${FAKE_PLAYER_ID}/player_es6.vflset/en_US/base.js`,
    ])
    expect(requests.every((request) => request.credentials === 'omit')).toBe(true)
    await scripts.current(ctx)
    expect(requests).toHaveLength(2)
    expect(extracted).toEqual([FAKE_PLAYER_ID])
  })

  it('checks the ID again after 6 hours and fetches the script only when it changed', async () => {
    const { scripts, ctx, requests, extracted, advance, setPlayer } = setup()
    await scripts.current(ctx)
    advance(6 * HOUR)
    expect((await scripts.current(ctx)).playerId).toBe(FAKE_PLAYER_ID)
    expect(requests.map((request) => request.url.pathname)).toEqual([
      '/iframe_api',
      `/s/player/${FAKE_PLAYER_ID}/player_es6.vflset/en_US/base.js`,
      '/iframe_api',
    ])
    advance(6 * HOUR)
    setPlayer('abcdef12')
    expect((await scripts.current(ctx)).playerId).toBe('abcdef12')
    expect(extracted).toEqual([FAKE_PLAYER_ID, 'abcdef12'])
  })

  it('shares one fetch between concurrent callers', async () => {
    const { scripts, ctx, requests } = setup()
    await Promise.all([scripts.current(ctx), scripts.current(ctx), scripts.current(ctx)])
    expect(requests).toHaveLength(2)
  })

  it('starts from a stored script, and keeps what it fetches', async () => {
    const stored: PlayerScript = {
      playerId: 'abcdef12',
      signatureTimestamp: 20001,
      script: 'const exportedVars = {}',
      checkedAt: 1_000_000 - HOUR,
    }
    const { scripts, ctx, requests, saved } = setup({ store: { value: stored } })
    expect(await scripts.current(ctx)).toEqual(stored)
    expect(requests).toHaveLength(0)
    scripts.invalidate()
    await scripts.current(ctx)
    expect(saved.map((script) => script.playerId)).toEqual([FAKE_PLAYER_ID])
  })

  it('checks the ID again after invalidate, and keeps the script while the player is the same', async () => {
    const { scripts, ctx, requests, extracted, setPlayer } = setup()
    await scripts.current(ctx)
    scripts.invalidate()
    expect((await scripts.current(ctx)).playerId).toBe(FAKE_PLAYER_ID)
    expect(requests.map((request) => request.url.pathname)).toEqual([
      '/iframe_api',
      `/s/player/${FAKE_PLAYER_ID}/player_es6.vflset/en_US/base.js`,
      '/iframe_api',
    ])
    scripts.invalidate()
    setPlayer('abcdef12')
    expect((await scripts.current(ctx)).playerId).toBe('abcdef12')
    expect(extracted).toEqual([FAKE_PLAYER_ID, 'abcdef12'])
  })

  it('lets a caller stop waiting without stopping the fetch for the others', async () => {
    const { scripts, ctx, requests } = setup()
    const controller = new AbortController()
    const cancelled = scripts.current({ ...ctx, signal: controller.signal })
    const waiting = scripts.current(ctx)
    controller.abort(new Error('skipped'))
    await expect(cancelled).rejects.toThrow('skipped')
    expect((await waiting).playerId).toBe(FAKE_PLAYER_ID)
    expect(requests).toHaveLength(2)
  })

  it('ignores a malformed stored script', async () => {
    const { scripts, ctx, requests } = setup({ store: { value: { playerId: '../evil' } } })
    expect((await scripts.current(ctx)).playerId).toBe(FAKE_PLAYER_ID)
    expect(requests).toHaveLength(2)
  })

  it('fails with Network for a failed request and Parse without a player ID', async () => {
    const failing = new PlayerScripts({
      extract: fakeExtractor().extract,
    })
    const down = fakeInnerTube((request) =>
      request.url.href === IFRAME_API_URL ? new Response('', { status: 503 }) : undefined,
    )
    await expect(failing.current(context(down.fetch))).rejects.toMatchObject({ code: 'Network' })
    const empty = fakeInnerTube((request) =>
      request.url.href === IFRAME_API_URL ? new Response('nothing') : undefined,
    )
    await expect(failing.current(context(empty.fetch))).rejects.toMatchObject({ code: 'Parse' })
  })

  it('refuses an extract without a signatureTimestamp, and fetches only player scripts', async () => {
    const zero = new PlayerScripts({ extract: fakeExtractor({ signatureTimestamp: 0 }).extract })
    const { fetch } = fakeInnerTube(onIframeApi(), onPlayerScript())
    await expect(zero.current(context(fetch))).rejects.toMatchObject({ code: 'Parse' })
    const sneaky = new PlayerScripts({
      extract: async (_id, fetchScript) => {
        await fetchScript('https://evil.example/base.js')
        return { signatureTimestamp: 1, script: 'x' }
      },
    })
    await expect(sneaky.current(context(fetch))).rejects.toMatchObject({ code: 'Unsupported' })
  })
})
