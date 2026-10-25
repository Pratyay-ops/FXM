/**
 * The evaluation's commands, run through Vitest so they get the workspace's TypeScript. Each one
 * runs only when `FXM_EVAL` names it; the network commands also need `FXM_LIVE=1` and a
 * residential connection. See `README.md` in this folder for the whole procedure.
 *
 * ```sh
 * # 1. Inputs from Spotify and MusicBrainz (resumable)
 * FXM_LIVE=1 FXM_EVAL=inputs scripts/run.sh pnpm vitest run packages/sources/src/eval/commands.test.ts
 * # 2. YouTube Music pages, through the shared budget as bulk work (resumable, about 3 hours)
 * FXM_LIVE=1 FXM_EVAL=record scripts/run.sh pnpm vitest run packages/sources/src/eval/commands.test.ts
 * # 3. Labels and the review checklist (offline)
 * FXM_EVAL=label scripts/run.sh pnpm vitest run packages/sources/src/eval/commands.test.ts
 * # 4. After the owner's review of REVIEW.csv (offline)
 * FXM_EVAL=apply-review scripts/run.sh pnpm vitest run packages/sources/src/eval/commands.test.ts
 * ```
 *
 * Options: `FXM_EVAL_PLAN` (`full`, the default, or `proof`), `FXM_EVAL_LIMIT` (at most this many
 * new groups for `inputs`, groups for `record`), `FXM_EVAL_CSV` (the path of the owner's
 * Exportify CSV, added by `inputs`). `FXM_EVAL=all` runs inputs, record and label in a row.
 */

import type { ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createMusicBrainzClient, findExactIsrcs, findIsrcHint } from '../musicbrainz'
import { createSpotifyProvider, DEFAULT_SPOTIFY_CONFIG } from '../spotify'
import { createYouTubeProviders } from '../youtube'
import { buildInputs, INPUT_PLANS } from './inputs'
import { recordGroups } from './recorder'
import { applyReview, labelGroups, REVIEW_FILE } from './review'
import { checkpointStorage, fileStore } from './store'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const command = env?.FXM_EVAL ?? ''
const live = env?.FXM_LIVE === '1'
const plan = env?.FXM_EVAL_PLAN === 'proof' ? 'proof' : 'full'
const limit = env?.FXM_EVAL_LIMIT === undefined ? undefined : Number(env.FXM_EVAL_LIMIT)

const runs = (name: string) => command === name || command === 'all'

/** Every capability, as the desktop app has them: Node reaches every host. */
const CAPABILITIES = {
  youtube: 'full',
  spotify: 'anonymous',
  mediaBytes: true,
  fileSystem: false,
} as const satisfies ProviderContext['capabilities']

function log(line: string): void {
  console.info(`[eval ${new Date().toISOString().slice(11, 19)}] ${line}`)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** A fetch that waits until `ms` have passed since its last request started, and counts. */
function paced(fetchImpl: typeof fetch, ms: number, count: () => void): typeof fetch {
  let next = 0
  return async (input, init) => {
    const wait = next - Date.now()
    next = Math.max(Date.now(), next) + ms
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    count()
    return fetchImpl(input, init)
  }
}

/** What the recorder needs of `@fxm/platform`, loaded at run time (it type-checks with the DOM). */
interface PlatformModule {
  createRequestBudget(options: { storage: ReturnType<typeof checkpointStorage> }): {
    whenAvailable(priority: 'bulk', options?: { signal?: AbortSignal }): Promise<void>
    reportBotCheck(cause: 'login-required' | 'rate-limited'): void
    snapshot(): { used: number; remaining: number; bulkPausedUntil?: number }
  }
  createNodeTransport(options: {
    budget: ReturnType<PlatformModule['createRequestBudget']>
    userAgent?: string
  }): { withPriority(priority: 'bulk'): typeof fetch }
}

async function loadPlatform(): Promise<PlatformModule> {
  const specifier = '@fxm/platform'
  return (await import(/* @vite-ignore */ specifier)) as PlatformModule
}

async function readFileText(path: string): Promise<string> {
  const specifier = 'node:fs/promises'
  const fs = (await import(/* @vite-ignore */ specifier)) as {
    readFile(path: string, encoding: 'utf8'): Promise<string>
  }
  return fs.readFile(path, 'utf8')
}

describe.skipIf(command === '')('the matching evaluation', () => {
  const store = fileStore()

  it.runIf(runs('inputs'))('builds the inputs', { timeout: 2 * 3600_000 }, async () => {
    expect(live, 'FXM_LIVE=1 is required: this reads Spotify and MusicBrainz').toBe(true)
    const checkpoint = await store.readCheckpoint()
    const spotifyFetch = paced(globalThis.fetch, 1000, () => {
      checkpoint.requests.spotify += 1
    })
    const musicBrainzFetch: typeof fetch = (input, init) => {
      checkpoint.requests.musicbrainz += 1
      return globalThis.fetch(input, init)
    }
    const spotify = createSpotifyProvider()
    const musicBrainz = createMusicBrainzClient()
    const context = (fetchImpl: typeof fetch): ProviderContext => ({
      fetch: fetchImpl,
      platform: 'desktop',
      capabilities: CAPABILITIES,
      mode: 'music',
      locale: 'en',
    })
    const csvPath = env?.FXM_EVAL_CSV
    const summary = await buildInputs({
      providers: {
        spotify,
        findExactIsrcs: (references, ctx) =>
          findExactIsrcs(musicBrainz, references, ctx, { priority: 'bulk' }),
        findIsrcHint: (track, ctx) => findIsrcHint(musicBrainz, track, ctx, { priority: 'bulk' }),
      },
      spotifyCtx: context(spotifyFetch),
      musicBrainzCtx: context(musicBrainzFetch),
      store,
      checkpoint,
      plan,
      ...(limit === undefined ? {} : { limit }),
      ...(csvPath === undefined
        ? {}
        : {
            csv: {
              file: csvPath.split('/').at(-1) ?? 'export.csv',
              text: await readFileText(csvPath),
            },
          }),
      today: today(),
      log,
    })
    log(
      `inputs: ${summary.created.length} created, ${summary.completed.length} completed, ` +
        `${Object.keys(summary.failed).length} failed; requests so far: ` +
        `Spotify ${checkpoint.requests.spotify}, MusicBrainz ${checkpoint.requests.musicbrainz}`,
    )
    for (const [key, why] of Object.entries(summary.failed)) log(`failed ${key}: ${why}`)
    log(`plan ${plan}: ${INPUT_PLANS[plan].length} sources`)
  })

  it.runIf(runs('record'))('records the pages', { timeout: 10 * 3600_000 }, async () => {
    expect(live, 'FXM_LIVE=1 is required: this reads YouTube Music').toBe(true)
    const platform = await loadPlatform()
    const checkpoint = await store.readCheckpoint()
    const budget = platform.createRequestBudget({ storage: checkpointStorage(checkpoint) })
    const transport = platform.createNodeTransport({
      budget,
      userAgent: DEFAULT_SPOTIFY_CONFIG.userAgent,
    })
    const { music, video } = createYouTubeProviders()
    const summary = await recordGroups({
      providers: { music, video },
      ctx: {
        fetch: transport.withPriority('bulk'),
        platform: 'desktop',
        capabilities: CAPABILITIES,
        mode: 'music',
        locale: 'en',
      },
      budget,
      store,
      checkpoint,
      ...(limit === undefined ? {} : { limit }),
      log,
    })
    const snapshot = budget.snapshot()
    log(
      `record: ${summary.recorded.length} recorded, ${summary.deferred.length} deferred, ` +
        `${summary.remaining} remaining, ${summary.pages} pages this run, ` +
        `${checkpoint.requests.youtube} in all; budget ${snapshot.used} used this hour` +
        (summary.stopped === undefined ? '' : `; stopped: ${summary.stopped}`),
    )
  })

  it.runIf(runs('label'))(
    'drafts the labels and the review checklist',
    { timeout: 600_000 },
    async () => {
      const summary = await labelGroups(store)
      log(
        `labels: ${summary.changed.length} groups changed; ${REVIEW_FILE}: ${summary.rows} rows, ` +
          `${summary.ambiguous} ambiguous`,
      )
    },
  )

  it.runIf(command === 'apply-review')(
    'applies the owner review',
    { timeout: 600_000 },
    async () => {
      const csv = await store.readText(REVIEW_FILE)
      expect(csv, `${REVIEW_FILE} in the evaluation folder`).toBeDefined()
      const summary = await applyReview(store, csv ?? '', today())
      log(`review: ${summary.applied} applied, ${summary.open} open`)
      for (const line of summary.rejected) log(`rejected: ${line}`)
      await labelGroups(store)
    },
  )
})
