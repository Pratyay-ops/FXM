/**
 * The Android app's engine (stages 6.3 and 6.4): Media3 through the native engine, and the
 * WebView's own `<audio>` elements, the direct audio engine, once Media3's service turns out to be
 * unavailable.
 *
 * The app's player is made at once, with the first render, so the native engine attaches to
 * Media3 in the background (`NativeEngine.ifAvailable()`) and only its `connect` tells whether
 * that worked: it rejects when the service could not be bound. {@link AndroidEngine.connect}
 * then falls back ({@link AndroidEngine.fallBack}): the same player moves to the direct audio
 * engine, so whatever holds the player (the stream lifecycle, the play buttons, the pages) keeps
 * it:
 *
 * - a load the player still waits for is loaded on the direct audio engine, where it had got to,
 *   and plays if the player had asked it to play; a load the native engine failed or ended is the
 *   player's to handle, and it retries or moves on through the direct audio engine;
 * - the volume, the mute and what was preloaded carry over;
 * - the native engine's events stop counting, and it is destroyed;
 * - {@link AndroidEngine.network} goes from Android's callbacks to the WebView's events.
 *
 * @module
 */

import { FxmError, type StreamOption } from '@fxm/core'
import {
  createBrowserNetworkMonitor,
  DirectAudioEngine,
  type DisposableNetworkMonitor,
  type Engine,
  type EngineEventMap,
  type EngineEventType,
  type NativeConnection,
  type NativeConnectOptions,
  type NativeEngine,
  type NetworkMonitor,
  type PlaybackSource,
  type PlaySupport,
  type StreamResolver,
} from '@fxm/player'

/** A listener on the engine, registered on the engine it plays through. */
interface Registration {
  readonly type: EngineEventType
  readonly listener: (payload: EngineEventMap[EngineEventType]) => void
  /** Removes it from that engine. */
  off: () => void
}

/** The source the player loaded last, while it waits for it: it neither failed nor ended. */
interface Pending {
  readonly source: PlaybackSource
  /** Where it got to, in milliseconds. */
  positionMs: number
  /** Whether it plays, or the player asked it to. */
  playing: boolean
}

/** Options for {@link AndroidEngine}. */
export interface AndroidEngineOptions {
  /** The engine to fall back to. Default: a `DirectAudioEngine`. */
  readonly createFallback?: () => Engine
  /** The network after the fallback. Default: the WebView's (`createBrowserNetworkMonitor`). */
  readonly createNetwork?: () => DisposableNetworkMonitor
}

/** A {@link NetworkMonitor} that follows another one, which can be replaced. */
class FollowingNetwork implements NetworkMonitor {
  readonly #listeners = new Set<() => void>()
  #current: NetworkMonitor
  #own: DisposableNetworkMonitor | undefined
  #stop: () => void

  constructor(initial: NetworkMonitor) {
    this.#current = initial
    this.#stop = initial.subscribe(() => this.#notify())
  }

  get id(): string {
    return this.#current.id
  }

  get cellular(): boolean {
    return this.#current.cellular
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Follows `next` from now on, which counts as a change of network. */
  replace(next: DisposableNetworkMonitor): void {
    this.#stop()
    this.#own?.destroy()
    this.#own = next
    this.#current = next
    this.#stop = next.subscribe(() => this.#notify())
    this.#notify()
  }

  destroy(): void {
    this.#stop()
    this.#own?.destroy()
    this.#listeners.clear()
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error) {
        console.error(error)
      }
    }
  }
}

/** The Android app's engine (see the module documentation). */
export class AndroidEngine implements Engine {
  readonly #registrations = new Set<Registration>()
  readonly #createFallback: () => Engine
  readonly #createNetwork: () => DisposableNetworkMonitor
  readonly #network: FollowingNetwork
  #engine: Engine
  #native: NativeEngine | undefined
  #pending: Pending | undefined
  #preloaded: PlaybackSource | null = null
  #volume = 1
  #muted = false
  #destroyed = false

  /** Plays through `native` until {@link fallBack}. */
  constructor(native: NativeEngine, options: AndroidEngineOptions = {}) {
    this.#native = native
    this.#engine = native
    this.#createFallback = options.createFallback ?? (() => new DirectAudioEngine())
    this.#createNetwork = options.createNetwork ?? (() => createBrowserNetworkMonitor())
    this.#network = new FollowingNetwork(native.network)
    this.on('timeupdate', (positionMs) => {
      if (this.#pending !== undefined) this.#pending.positionMs = positionMs
    })
    this.on('play', () => this.#setPlaying(true))
    this.on('pause', () => this.#setPlaying(false))
    // The player handles these itself, through whichever engine it then plays on.
    this.on('ended', () => {
      this.#pending = undefined
    })
    this.on('error', () => {
      this.#pending = undefined
    })
  }

  /** The native engine, until the engine fell back to the direct audio engine. */
  get native(): NativeEngine | undefined {
    return this.#native
  }

  /**
   * The network for the stream lifecycle: the native engine's, Android's own callbacks, which
   * keep arriving with the screen off; after {@link fallBack}, the WebView's events.
   */
  get network(): NetworkMonitor {
    return this.#network
  }

  /**
   * The resolver to give the player: `resolver` behind the native engine's wrapper, which takes
   * over what Media3 already plays without a request (`NativeEngine.wrapResolver`), and
   * `resolver` itself once the engine fell back.
   */
  wrapResolver(resolver: StreamResolver): StreamResolver {
    const wrapped = this.#native?.wrapResolver(resolver) ?? resolver
    return {
      resolve: (item, request) =>
        (this.#native === undefined ? resolver : wrapped).resolve(item, request),
    }
  }

  /**
   * Connects the native engine to the player (`NativeEngine.connect`, see its README). When that
   * rejects, Media3's service is unavailable: the engine falls back ({@link fallBack}) before the
   * promise rejects with the native engine's reason. Once fallen back, it rejects at once.
   */
  async connect(options: NativeConnectOptions): Promise<NativeConnection> {
    const native = this.#native
    if (native === undefined) {
      throw new FxmError('Unavailable', 'The native player is not available')
    }
    try {
      return await native.connect(options)
    } catch (error) {
      this.fallBack()
      throw error
    }
  }

  /**
   * Plays through the direct audio engine from now on, in the same player: for when Media3's
   * service is unavailable. Destroys the native engine. Does nothing once it fell back, or after
   * {@link destroy}.
   */
  fallBack(): void {
    const native = this.#native
    if (native === undefined || this.#destroyed) return
    this.#native = undefined
    const engine = this.#createFallback()
    this.#engine = engine
    for (const registration of this.#registrations) {
      registration.off()
      registration.off = engine.on(registration.type, registration.listener)
    }
    native.destroy()
    this.#network.replace(this.#createNetwork())
    engine.setVolume(this.#volume)
    engine.setMuted(this.#muted)
    const pending = this.#pending
    if (pending !== undefined) {
      const { source, positionMs, playing } = pending
      engine
        .load(source, positionMs)
        .then(() => {
          if (playing && this.#engine === engine && this.#pending === pending) return engine.play()
        })
        .catch((error: unknown) => console.error(error))
    }
    if (this.#preloaded !== null) engine.preload?.(this.#preloaded)
  }

  load(source: PlaybackSource, startAtMs = 0): Promise<void> {
    this.#pending = { source, positionMs: startAtMs, playing: false }
    return this.#engine.load(source, startAtMs)
  }

  play(): Promise<void> {
    this.#setPlaying(true)
    return this.#engine.play()
  }

  pause(): void {
    this.#setPlaying(false)
    this.#engine.pause()
  }

  seek(positionMs: number): void {
    if (this.#pending !== undefined) this.#pending.positionMs = positionMs
    this.#engine.seek(positionMs)
  }

  setVolume(volume: number): void {
    this.#volume = volume
    this.#engine.setVolume(volume)
  }

  setMuted(muted: boolean): void {
    this.#muted = muted
    this.#engine.setMuted(muted)
  }

  preload(source: PlaybackSource | null): void {
    this.#preloaded = source
    this.#engine.preload?.(source)
  }

  canPlay(stream: StreamOption): PlaySupport {
    return this.#engine.canPlay?.(stream) ?? 'maybe'
  }

  unlock(): void {
    this.#engine.unlock?.()
  }

  on<K extends EngineEventType>(
    type: K,
    listener: (payload: EngineEventMap[K]) => void,
  ): () => void {
    const registration: Registration = {
      type,
      listener: listener as (payload: EngineEventMap[EngineEventType]) => void,
      off: this.#destroyed ? () => {} : this.#engine.on(type, listener),
    }
    if (!this.#destroyed) this.#registrations.add(registration)
    return () => {
      registration.off()
      this.#registrations.delete(registration)
    }
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    for (const registration of this.#registrations) registration.off()
    this.#registrations.clear()
    this.#pending = undefined
    this.#engine.destroy()
    this.#network.destroy()
  }

  #setPlaying(playing: boolean): void {
    if (this.#pending !== undefined) this.#pending.playing = playing
  }
}
