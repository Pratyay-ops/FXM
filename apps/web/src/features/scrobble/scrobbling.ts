/**
 * Scrobbling in the web app (stage 8.2): the scrobbler of `@fxm/sources/scrobble`, fed with the
 * player's plays, sending to the accounts connected in Settings, with its queue in IndexedDB.
 *
 * - **Every tab** queues its own player's plays into the one shared queue, and the tabs take
 *   turns sending it under a Web Lock, so no scrobble goes out twice.
 * - **Offline:** plays keep queueing; the queue is sent when the browser says it is online
 *   again, and on the next start.
 * - **Requests** go straight from the browser to `api.listenbrainz.org` and
 *   `ws.audioscrobbler.com`, which answer any origin, so every tier can scrobble.
 *
 * This module, the clients and Dexie load only once an account is connected (or Settings
 * opens): `start-scrobbling.ts`, which the app runs at start, loads them then.
 *
 * @module
 */

import {
  type LastfmCredentials,
  LastfmScrobbleClient,
  ListenBrainzScrobbleClient,
  lastfmTarget,
  listenBrainzTarget,
  type ScrobbleContext,
  type ScrobblePlay,
  Scrobbler,
  type ScrobbleStore,
  type ScrobbleTarget,
} from '@fxm/sources/scrobble'
import type { NewPlay } from '../../db/repo'
import type { PlayListener } from '../signals/play-events'
import {
  createDexieScrobbleStore,
  openScrobbleDatabase,
  type ScrobbleDatabase,
} from './scrobble-db'
import {
  hasAccounts,
  type ScrobblingAccounts,
  type ScrobblingStore,
  useScrobblingStore,
} from './scrobbling-store'

/** The Web Lock the tabs take turns on to send the shared queue. */
export const FLUSH_LOCK = 'fxm-scrobble-flush'

/** The context scrobble requests go out with: the browser's own `fetch`, read at each call. */
export function scrobbleContext(): ScrobbleContext {
  return { fetch: (input, init) => globalThis.fetch(input, init) }
}

/** The ListenBrainz client for a token, kept while the token is, so its rate limits hold. */
let listenbrainzClient: { token: string; client: ListenBrainzScrobbleClient } | undefined

/** The ListenBrainz client for `token`. */
export function listenBrainzClientFor(token: string): ListenBrainzScrobbleClient {
  if (listenbrainzClient?.token !== token) {
    listenbrainzClient = { token, client: new ListenBrainzScrobbleClient(token) }
  }
  return listenbrainzClient.client
}

/** The Last.fm client for an API account, kept while the account is. */
let lastfmClient: { key: string; client: LastfmScrobbleClient } | undefined

/** The Last.fm client for an API account's key and secret. */
export function lastfmClientFor(credentials: LastfmCredentials): LastfmScrobbleClient {
  const key = `${credentials.apiKey}:${credentials.secret}`
  if (lastfmClient?.key !== key) {
    lastfmClient = {
      key,
      client: new LastfmScrobbleClient({ apiKey: credentials.apiKey, secret: credentials.secret }),
    }
  }
  return lastfmClient.client
}

/**
 * The scrobbler targets for the connected accounts: paused while their service refuses them,
 * and named by their credential, so a refusal of an older one doesn't pause a newer one.
 */
export function targetsFor(accounts: ScrobblingAccounts): ScrobbleTarget[] {
  const targets: ScrobbleTarget[] = []
  const { listenbrainz, lastfm } = accounts
  if (listenbrainz !== undefined) {
    targets.push(
      listenBrainzTarget(listenBrainzClientFor(listenbrainz.token), {
        paused: listenbrainz.refusedAt !== undefined,
        account: listenbrainz.token,
      }),
    )
  }
  if (lastfm !== undefined) {
    targets.push(
      lastfmTarget(lastfmClientFor(lastfm), lastfm.sessionKey, {
        paused: lastfm.refusedAt !== undefined,
        account: lastfm.sessionKey,
      }),
    )
  }
  return targets
}

/** Whether the browser says it is online. */
function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * Runs `task` holding {@link FLUSH_LOCK}, where Web Locks exist (secure contexts in browsers
 * since 2022); as it is elsewhere.
 */
function acrossTabs<T>(task: () => Promise<T>): Promise<T> {
  // Typed as always there, but missing in insecure contexts, and null in some test DOMs.
  const locks: LockManager | null | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.locks
  return typeof locks?.request === 'function' ? locks.request(FLUSH_LOCK, () => task()) : task()
}

/** What the app's scrobbler is built from; tests pass their own. */
export interface ScrobblingDeps {
  /** Where the queue lives. */
  store: ScrobbleStore
  /** The connected accounts. */
  accounts: ScrobblingStore
  /** The context of every request. */
  context: () => ScrobbleContext
}

/** A scrobbler that sends to the accounts in `deps.accounts`, and marks the ones refused. */
export function createAppScrobbler(deps: ScrobblingDeps): Scrobbler {
  return new Scrobbler({
    store: deps.store,
    targets: () => targetsFor(deps.accounts.getState()),
    context: deps.context,
    onRefused: (service, _error, target) => {
      if (target.account !== undefined) {
        deps.accounts.getState().markRefused(service, target.account, Date.now())
      }
    },
    online,
    exclusive: acrossTabs,
  })
}

/** A finished play from the play recorder, as the scrobbler takes it. */
export function scrobblePlayOf(play: NewPlay, now: number = Date.now()): ScrobblePlay {
  const result: ScrobblePlay = {
    track: play.track,
    at: play.playedAt ?? now,
    playedMs: play.playedMs,
  }
  if (play.durationMs !== undefined) result.durationMs = play.durationMs
  if (play.context !== undefined) result.context = play.context
  return result
}

/**
 * What `scrobbler` does with the player's plays (see `play-events.ts`), while an account is
 * connected: a start is announced as playing now, and a play that ended is scrobbled.
 */
export function playListenerFor(scrobbler: Scrobbler, accounts: ScrobblingStore): PlayListener {
  const connected = () => hasAccounts(accounts.getState())
  return {
    started: ({ track, context }) => {
      if (connected()) scrobbler.playStarted(context === undefined ? { track } : { track, context })
    },
    ended: (play) => {
      // An imported history never reaches here, but would never be scrobbled either.
      if (play.importId !== undefined || !connected()) return
      scrobbler
        .playEnded(scrobblePlayOf(play))
        .catch((error: unknown) => console.error('The play could not be scrobbled', error))
    },
  }
}

/**
 * Keeps `scrobbler` sending: when the browser comes back online, and when an account is
 * connected or allowed again. It also sends what an earlier session left, at once. Returns the
 * function that stops it.
 */
export function keepSending(scrobbler: Scrobbler, accounts: ScrobblingStore): () => void {
  const stops: (() => void)[] = []
  if (typeof window !== 'undefined') {
    const onOnline = () => {
      if (hasAccounts(accounts.getState())) void scrobbler.retryNow()
    }
    window.addEventListener('online', onOnline)
    stops.push(() => window.removeEventListener('online', onOnline))
  }
  stops.push(
    accounts.subscribe((state, previous) => {
      const changed =
        state.listenbrainz !== previous.listenbrainz || state.lastfm !== previous.lastfm
      if (changed && targetsFor(state).some((target) => !target.paused)) void scrobbler.flush()
    }),
  )
  if (hasAccounts(accounts.getState())) void scrobbler.flush()
  return () => {
    for (const stop of stops.reverse()) stop()
  }
}

let database: ScrobbleDatabase | undefined
let store: ScrobbleStore | undefined
let scrobbler: Scrobbler | undefined

/** The app's queue store, on the `fxm-scrobble` database (opened on its first use). */
export function getScrobbleStore(): ScrobbleStore {
  if (store === undefined) {
    database = openScrobbleDatabase()
    store = createDexieScrobbleStore(database)
  }
  return store
}

/** The app's scrobbler. */
export function getScrobbler(): Scrobbler {
  scrobbler ??= createAppScrobbler({
    store: getScrobbleStore(),
    accounts: useScrobblingStore,
    context: scrobbleContext,
  })
  return scrobbler
}

/** The app's scrobbling, running: what it does with plays, and how to stop it. */
export interface AppScrobbling {
  /** What the app's scrobbler does with the player's plays. */
  listener: PlayListener
  /** Stops it sending on its own (online, accounts). */
  stop: () => void
}

/** Runs the app's scrobbling. `start-scrobbling.ts` calls it once, after loading this module. */
export function runAppScrobbling(): AppScrobbling {
  const app = getScrobbler()
  return {
    listener: playListenerFor(app, useScrobblingStore),
    stop: keepSending(app, useScrobblingStore),
  }
}

/** Tests only: closes the app's scrobbler and deletes its queue, so the next test starts over. */
export async function resetScrobbling(): Promise<void> {
  scrobbler?.close()
  scrobbler = undefined
  store = undefined
  listenbrainzClient = undefined
  lastfmClient = undefined
  const open = database
  database = undefined
  open?.close()
  await openScrobbleDatabase().delete()
  useScrobblingStore.setState(useScrobblingStore.getInitialState(), true)
}
