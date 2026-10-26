import { createServer, type Server } from 'node:http'
import { expect, type Frame, type Page, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../../src/app/services/testing/fake-network'
import { FIXTURES, fixture, stubNetwork } from '../fake-services'
import { type MediaRecord, trackMediaElements } from '../playing'

// The embeddable player (stage 5.2) as `make dist` builds it, with the real providers, inside a
// page on another site: the page is served as `localhost` on its own port, FXM as `127.0.0.1`.
// Without FXM Connect it plays a YouTube Music song in the Lite tier, through the deployed sandbox
// document nested inside the player, with the `/embed/*` policy and nothing reaching the internet.

/** Creep on YouTube Music: its track page is recorded (next-creep-song.json). */
const VIDEO = 'zFYEYRcjK2g'
const TITLE = 'Creep'

/** A message the player posts to the page (src/embed/api.ts). */
interface PlayerMessage {
  readonly type: string
  readonly state?: { status: string; positionMs: number; track: { title: string } | null }
}

interface EmbedderWindow {
  received: PlayerMessage[]
}

/** The page on another site: it frames the player, says hello, and keeps what the player posts. */
function embedderPage(fxm: string, src: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>A music blog</title></head>
<body>
  <h1>A post with a song</h1>
  <iframe id="player" title="FXM player" src="${src}" width="100%" height="232"
    style="border:0;border-radius:12px" allow="autoplay"></iframe>
  <script>
    window.received = []
    addEventListener('message', (event) => {
      if (event.origin === ${JSON.stringify(fxm)}) window.received.push(event.data)
    })
    const player = document.getElementById('player')
    player.addEventListener('load', () =>
      player.contentWindow.postMessage({ type: 'fxm-embed:hello', protocol: 1 }, ${JSON.stringify(fxm)}),
    )
  </script>
</body></html>`
}

/** Serves `html` as `localhost` on the port given, another site than FXM's 127.0.0.1. */
async function serveElsewhere(port: number, html: string): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}

function received(page: Page): Promise<PlayerMessage[]> {
  return page.evaluate(() => (window as unknown as EmbedderWindow).received)
}

/** The player's frame, once it is there. */
async function playerFrame(page: Page, fxm: string): Promise<Frame> {
  let frame: Frame | undefined
  await expect
    .poll(() => {
      frame = page.frames().find((candidate) => candidate.url().startsWith(`${fxm}/embed/`))
      return frame !== undefined
    })
    .toBe(true)
  return frame as Frame
}

test('plays a YouTube Music song in Lite inside a page on another site', async ({
  page,
}, testInfo) => {
  const fxm = new URL(testInfo.project.use.baseURL ?? '').origin
  const port = Number(new URL(fxm).port) + 1 + testInfo.parallelIndex
  const elsewhere = `http://localhost:${port}`
  const server = await serveElsewhere(port, embedderPage(fxm, `${fxm}/embed/track/ytm:${VIDEO}`))
  try {
    const network = createFakeNetwork({
      fixtures: {
        ...FIXTURES,
        tracks: { [VIDEO]: fixture('youtube/fixtures/next-creep-song.json') },
      },
      audio: wavTone(30),
    })
    await stubNetwork(page, network, { local: [elsewhere] })
    await trackMediaElements(page)
    // Every frame keeps the policy violations it sees.
    await page.addInitScript(() => {
      const seen: string[] = []
      Object.assign(window, { fxmViolations: seen })
      document.addEventListener('securitypolicyviolation', (event) => {
        seen.push(`${event.effectiveDirective} ${event.blockedURI}`)
      })
    })

    await page.goto(elsewhere)
    const player = page.frameLocator('#player')
    const play = player.getByRole('button', { name: `Play ${TITLE}` })
    await expect(play).toBeVisible({ timeout: 20_000 })
    const ready = (await received(page)).find((message) => message.type === 'fxm-embed:ready')
    expect(ready).toBeDefined()

    await play.click()

    // The player says it plays, and its position moves on.
    await expect
      .poll(
        async () =>
          (await received(page)).some(
            (message) =>
              message.type === 'fxm-embed:state' &&
              message.state?.status === 'playing' &&
              message.state.positionMs >= 1500 &&
              message.state.track?.title === TITLE,
          ),
        { timeout: 20_000 },
      )
      .toBe(true)
    await expect(player.getByRole('button', { name: 'Pause' })).toBeVisible()
    // A media element in the player's frame plays from googlevideo.
    const frame = await playerFrame(page, fxm)
    const media = await frame.evaluate(() =>
      [...(window as unknown as MediaRecord).fxmMedia]
        .filter((element) => element.currentSrc !== '')
        .map((element) => ({
          host: new URL(element.currentSrc).hostname,
          playing: !element.paused && element.currentTime > 1,
        })),
    )
    expect(media).toContainEqual({ host: 'rr1---sn-fxmfixture.googlevideo.com', playing: true })

    // Every InnerTube call came from the sandbox document's opaque origin, in the CORS-simple shape:
    // the Lite tier inside another site.
    const innerTube = network.requests.filter((request) => request.url.includes('/youtubei/v1/'))
    expect(innerTube.length).toBeGreaterThan(0)
    expect(innerTube.map((request) => request.headers.origin)).toEqual(innerTube.map(() => 'null'))
    expect(
      innerTube.every((request) => request.headers['content-type']?.startsWith('text/plain')),
    ).toBe(true)
    // The player's frame ran under the deployed `/embed/*` policy without a violation.
    expect(
      await frame.evaluate(() => (window as unknown as { fxmViolations: string[] }).fxmViolations),
    ).toEqual([])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
