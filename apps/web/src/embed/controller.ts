/**
 * The embed's logic, apart from its looks. It creates the platform for whatever the visitor's
 * browser offers (FXM Connect, then the Lite tier, then free sources only), loads what the
 * address names, and plays it with the player and the stream lifecycle of stages 2.2 and 2.3.
 * The view (`embed-app.tsx`) and the postMessage API (`api.ts`) both read its state and call
 * its actions.
 *
 * @module
 */

import {
  type CatalogMode,
  isFxmError,
  modePolicy,
  type NetworkCapabilities,
  type ProviderContext,
  parseId,
  playbackProblemOf,
  type QueueContext,
  type Track,
} from '@fxm/core'
import type { ContextOptions } from '@fxm/platform'
import {
  connectMediaSession,
  createBrowserNetworkMonitor,
  DirectAudioEngine,
  type DisposableNetworkMonitor,
  type Engine,
  type NetworkMonitor,
  Player,
  type PlayerOptions,
  type PlayerState,
  StreamLifecycle,
  type StreamSource,
  type TrackMatcher,
} from '@fxm/player'
import type { EmbedAttribution, EmbedCatalog, EmbedEntity } from './catalog'
import type { EmbedTarget } from './target'

/**
 * The parts of `@fxm/platform`'s `FxmPlatform` the embed uses, so tests can pass a small fake.
 */
export interface EmbedPlatform {
  /** What the platform can reach, kept up to date. */
  readonly capabilities: {
    readonly current: NetworkCapabilities
    subscribe(listener: (capabilities: NetworkCapabilities) => void): () => void
  }
  /** A provider context with the `fetch` for a budget priority and the current capabilities. */
  context(options: ContextOptions): ProviderContext
  /** Stops watching FXM Connect and frees the sandbox documents. */
  dispose(): void
}

/** What the embed needs from the providers: the metadata, and the streams. */
export interface EmbedServices {
  /** Loads what the embed shows. */
  readonly catalog: EmbedCatalog
  /** Resolves audio candidates into streams, one source each (the lifecycle's `sources`). */
  readonly sources: readonly StreamSource[]
  /** Finds songs for official videos in Music mode. Without one, only linked songs play. */
  readonly matcher?: TrackMatcher
}

/**
 * The tier the visitor's browser is in, as far as the embed cares: `full` with FXM Connect,
 * `lite` with the experimental no-install tier, `free` with free sources only.
 */
export type EmbedTier = 'full' | 'lite' | 'free'

/** The tier that `capabilities` amount to. */
export function tierOf(capabilities: NetworkCapabilities): EmbedTier {
  if (capabilities.youtube === 'full') return 'full'
  return capabilities.youtube === 'simple' ? 'lite' : 'free'
}

/** Whether a target's audio and metadata come from YouTube. */
export function needsYouTube(target: EmbedTarget): boolean {
  const { source } = parseId(target.id)
  return source === 'ytm' || source === 'yt'
}

/** Where the embed is: loading its content, ready to play, or unable to show it. */
export type EmbedPhase = 'loading' | 'ready' | 'unavailable'

/**
 * Why the embed can't show its content:
 *
 * - `not-found`: the source has no such track, album or playlist
 * - `needs-youtube`: it comes from YouTube, which this browser can't reach without FXM Connect
 *   (the Lite tier's self-test failed or its kill switch is on)
 * - `hidden-by-mode`: a video, and the embed plays songs only (no `mode=all`): one the mode
 *   hides, or an official video whose song it can't find
 * - `empty`: an album or playlist with nothing the catalog mode lets play
 * - `unsupported`: the embed can't load this source here
 * - `failed`: loading failed for a passing reason, such as the network or a bot check
 */
export type EmbedProblem =
  | 'not-found'
  | 'needs-youtube'
  | 'hidden-by-mode'
  | 'empty'
  | 'unsupported'
  | 'failed'

/**
 * Why the last track failed to play, while that matters: it needs FXM Connect, YouTube asked
 * for a bot check, the track is unavailable, or playback failed for another reason.
 */
export type PlaybackNotice = 'needs-youtube' | 'bot-check' | 'unavailable' | 'failed'

/** The embed's state. A new object on every change. */
export interface EmbedState {
  /** Loading, ready or unavailable. */
  readonly phase: EmbedPhase
  /** While unavailable: why. */
  readonly problem?: EmbedProblem
  /** The tier, once the platform said. */
  readonly tier?: EmbedTier
  /** What the embed shows, once loaded. */
  readonly entity?: EmbedEntity
  /** The player's state, once ready. Its queue holds the tracks that play, in order. */
  readonly player?: PlayerState
  /** Whether playback has started at all: until then the player shows nothing as current. */
  readonly started?: boolean
  /** Why the last track failed, until another one plays. */
  readonly notice?: PlaybackNotice
}

/** Options for {@link EmbedController}. */
export interface EmbedControllerOptions {
  /** What the address names. */
  target: EmbedTarget
  /** The catalog mode from the address. */
  mode: CatalogMode
  /**
   * Creates the platform. `youtube` says whether the target comes from YouTube: only then is
   * the Lite tier worth its self-test.
   */
  createPlatform(options: { youtube: boolean }): Promise<EmbedPlatform>
  /** The providers on that platform. */
  createServices(platform: EmbedPlatform): EmbedServices | Promise<EmbedServices>
  /** The playback engine. Default: a `DirectAudioEngine`. */
  createEngine?: () => Engine
  /** Shows what plays in the system's media controls. Default: true. */
  mediaSession?: boolean
  /** The network monitor for the URL cache. Default: the browser's. */
  network?: NetworkMonitor
  /** Options passed on to the player, such as retry delays in tests. */
  player?: Omit<PlayerOptions, 'engine' | 'resolver' | 'queue'>
}

/**
 * Wraps a stream source so that its InnerTube calls draw on the request budget at the priority
 * the lifecycle asks for: the track about to play, or prefetching the next ones. The lifecycle
 * passes the priority in the request; the provider context it builds has one `fetch` only.
 */
export function withBudgetPriority(source: StreamSource, platform: EmbedPlatform): StreamSource {
  const contextFor = (ctx: ProviderContext, priority: 'playback' | 'prefetch'): ProviderContext => {
    const { fetch } = platform.context({
      mode: ctx.mode,
      priority: priority === 'prefetch' ? 'prefetch' : 'current-track',
    })
    return { ...ctx, fetch }
  }
  return {
    id: source.id,
    ...(source.hasFallback === undefined ? {} : { hasFallback: source.hasFallback }),
    resolve: (candidate, request) =>
      source.resolve(candidate, { ...request, ctx: contextFor(request.ctx, request.priority) }),
    ...(source.checkStatus === undefined
      ? {}
      : {
          checkStatus: (stream, request) =>
            source.checkStatus?.(stream, {
              ...request,
              ctx: contextFor(request.ctx, 'playback'),
            }) ?? Promise.resolve(undefined),
        }),
  }
}

/**
 * Whether the embed can play `track` in `mode`: a song, or in Music mode an official video
 * through the song it links. One without a link needs the matching engine to find its song, so
 * it plays only with a `matcher`; anything the mode hides never does.
 */
export function playsIn(track: Track, mode: CatalogMode, matcher: boolean): boolean {
  const verdict = modePolicy(track, mode)
  return verdict === 'needs-song-match' ? matcher : verdict !== 'hidden'
}

/** The queue context an album or playlist plays from. */
function queueContextOf(entity: EmbedEntity): QueueContext | undefined {
  const { target, title } = entity
  if (target.kind === 'album') return { type: 'album', id: target.id, title }
  if (target.kind === 'playlist') return { type: 'playlist', id: target.id, title }
  return undefined
}

/**
 * The embed's controller: create one per page, call {@link EmbedController.start}, and read
 * its state with `getState` and `subscribe` (shaped for `useSyncExternalStore`).
 *
 * Call the playback actions straight from the user's gesture: the player unlocks audio
 * elements before it awaits anything, which Safari and Android WebViews require.
 */
export class EmbedController {
  readonly target: EmbedTarget
  readonly mode: CatalogMode
  readonly #options: EmbedControllerOptions
  readonly #listeners = new Set<() => void>()
  #state: EmbedState = { phase: 'loading' }
  #platform: EmbedPlatform | undefined
  /** The providers, once created; `#creatingServices` while they are being created. */
  #services: EmbedServices | undefined
  #creatingServices: Promise<EmbedServices> | undefined
  #player: Player | undefined
  #lifecycle: StreamLifecycle | undefined
  #network: DisposableNetworkMonitor | undefined
  readonly #stops: (() => void)[] = []
  #generation = 0
  #destroyed = false

  constructor(options: EmbedControllerOptions) {
    this.#options = options
    this.target = options.target
    this.mode = options.mode
  }

  /** The current state. */
  readonly getState = (): EmbedState => this.#state

  /** Calls `listener` after every change. Returns a function that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Creates the platform (once), then loads the content and prepares the player. Resolves when
   * the embed is ready or unavailable; never rejects. Calling it again loads the content again,
   * e.g. after a passing failure ({@link retry}).
   */
  async start(): Promise<void> {
    if (this.#destroyed) return
    this.#generation += 1
    const generation = this.#generation
    const current = () => generation === this.#generation && !this.#destroyed
    this.#update({ phase: 'loading', problem: undefined, notice: undefined })

    let platform: EmbedPlatform
    try {
      platform = await this.#ensurePlatform()
    } catch {
      if (current()) this.#update({ phase: 'unavailable', problem: 'failed' })
      return
    }
    if (!current()) return

    const capabilities = platform.capabilities.current
    this.#update({ tier: tierOf(capabilities) })
    if (needsYouTube(this.target) && capabilities.youtube === 'none') {
      this.#update({ phase: 'unavailable', problem: 'needs-youtube' })
      return
    }

    let services: EmbedServices
    let entity: EmbedEntity
    try {
      services = await this.#ensureServices(platform)
      entity = await services.catalog.load(
        this.target,
        platform.context({ mode: this.mode, priority: 'interactive' }),
      )
    } catch (error) {
      if (current()) this.#update({ phase: 'unavailable', problem: this.#problemOf(error) })
      return
    }
    if (!current()) return

    const matcher = services.matcher !== undefined
    const tracks = entity.tracks.filter((track) => playsIn(track, this.mode, matcher))
    if (tracks.length === 0) {
      const problem: EmbedProblem = this.target.kind === 'track' ? 'hidden-by-mode' : 'empty'
      this.#update({ phase: 'unavailable', problem, entity })
      return
    }

    const player = this.#ensurePlayer(platform, services)
    const context = queueContextOf(entity)
    await player.setQueue(tracks, { autoplay: false, ...(context ? { context } : {}) })
    if (!current()) return
    this.#update({ phase: 'ready', entity, player: player.getState() })
  }

  /** The credits a track needs where it plays, from the catalog (free sources ask for them). */
  readonly attributionOf = (track: Track): EmbedAttribution | undefined =>
    this.#services?.catalog.attribution?.(track)

  /** Loads the content again after it failed to load. */
  retry(): void {
    if (this.#state.phase === 'unavailable') void this.start()
  }

  /** Plays: resumes, or starts the track at `index` of the queue from its beginning. */
  play(index?: number): void {
    const player = this.#player
    if (player === undefined || this.#state.phase !== 'ready') return
    void player.play(index)
  }

  /** Plays or pauses. */
  toggle(): void {
    if (this.#state.phase === 'ready') void this.#player?.toggle()
  }

  /** Pauses. */
  pause(): void {
    this.#player?.pause()
  }

  /** Skips to the next track. */
  next(): void {
    if (this.#state.phase === 'ready') void this.#player?.next()
  }

  /** Goes back: restarts the track more than 3 s in, else plays the previous one. */
  previous(): void {
    if (this.#state.phase === 'ready') void this.#player?.previous()
  }

  /** Jumps to `ms` into the current track. */
  seek(ms: number): void {
    this.#player?.seek(ms)
  }

  /** Sets the volume, from 0 to 1. */
  setVolume(volume: number): void {
    this.#player?.setVolume(volume)
  }

  /** Mutes or unmutes. */
  setMuted(muted: boolean): void {
    this.#player?.setMuted(muted)
  }

  /** Stops playback and frees the player, the lifecycle, the platform and the listeners. */
  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    for (const stop of this.#stops.splice(0)) stop()
    this.#lifecycle?.destroy()
    this.#player?.destroy()
    this.#network?.destroy()
    this.#platform?.dispose()
    this.#listeners.clear()
  }

  async #ensurePlatform(): Promise<EmbedPlatform> {
    if (this.#platform !== undefined) return this.#platform
    const platform = await this.#options.createPlatform({ youtube: needsYouTube(this.target) })
    if (this.#destroyed) {
      platform.dispose()
      throw new Error('The embed was destroyed')
    }
    this.#platform = platform
    this.#stops.push(
      platform.capabilities.subscribe((capabilities) => this.#onCapabilities(capabilities)),
    )
    return platform
  }

  /** Creates the providers once, even when two loads overlap; a failure lets a later load retry. */
  #ensureServices(platform: EmbedPlatform): Promise<EmbedServices> {
    this.#creatingServices ??= Promise.resolve()
      .then(() => this.#options.createServices(platform))
      .then(
        (services) => {
          this.#services = services
          return services
        },
        (error: unknown) => {
          this.#creatingServices = undefined
          throw error
        },
      )
    return this.#creatingServices
  }

  /** FXM Connect appeared or went away, or the Lite tier changed. */
  #onCapabilities(capabilities: NetworkCapabilities): void {
    const tier = tierOf(capabilities)
    const { phase, problem } = this.#state
    this.#update({ tier })
    // YouTube is reachable now: load what needed it.
    if (phase === 'unavailable' && problem === 'needs-youtube' && tier !== 'free') {
      void this.start()
    }
  }

  #ensurePlayer(platform: EmbedPlatform, services: EmbedServices): Player {
    if (this.#player !== undefined) return this.#player
    let network = this.#options.network
    if (network === undefined) {
      this.#network = createBrowserNetworkMonitor()
      network = this.#network
    }
    const lifecycle = new StreamLifecycle({
      sources: services.sources.map((source) => withBudgetPriority(source, platform)),
      ...(services.matcher === undefined ? {} : { matcher: services.matcher }),
      context: () => platform.context({ mode: this.mode, priority: 'current-track' }),
      network,
    })
    const player = new Player({
      ...this.#options.player,
      engine: this.#options.createEngine?.() ?? new DirectAudioEngine(),
      resolver: lifecycle,
      queue: { mode: this.mode },
    })
    lifecycle.attach(player)
    this.#stops.push(
      player.subscribe((state) => this.#onPlayerState(state)),
      player.on('trackfailed', ({ error }) => {
        this.#update({ notice: this.#noticeOf(error) })
      }),
    )
    if (this.#options.mediaSession !== false) this.#stops.push(connectMediaSession(player))
    this.#player = player
    this.#lifecycle = lifecycle
    return player
  }

  #onPlayerState(state: PlayerState): void {
    if (this.#state.phase !== 'ready') return
    // A track that plays answers whatever went wrong before.
    const notice = state.status === 'playing' ? undefined : this.#state.notice
    const started =
      this.#state.started === true || state.status === 'loading' || state.status === 'playing'
    this.#update({ player: state, notice, ...(started ? { started } : {}) })
  }

  #problemOf(error: unknown): EmbedProblem {
    if (!isFxmError(error)) return 'failed'
    if (error.code === 'NotFound') return 'not-found'
    if (error.code === 'Unsupported') {
      const youtube = this.#platform?.capabilities.current.youtube
      return needsYouTube(this.target) && youtube === 'none' ? 'needs-youtube' : 'unsupported'
    }
    return 'failed'
  }

  #noticeOf(error: Error): PlaybackNotice {
    if (playbackProblemOf(error) !== undefined) return 'unavailable'
    if (!isFxmError(error)) return 'failed'
    switch (error.code) {
      case 'Unsupported':
        return needsYouTube(this.target) ? 'needs-youtube' : 'failed'
      case 'BotCheck':
        return 'bot-check'
      case 'NotFound':
      case 'Unavailable':
      case 'GeoBlocked':
        return 'unavailable'
      default:
        return 'failed'
    }
  }

  #update(patch: { [K in keyof EmbedState]?: EmbedState[K] | undefined }): void {
    if (this.#destroyed) return
    const next: Record<string, unknown> = { ...this.#state }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    this.#state = next as unknown as EmbedState
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error) {
        console.error(error)
      }
    }
  }
}
