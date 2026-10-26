import { saysSpotifyLoginUnused } from '@fxm/platform'
import { useLiveQuery } from 'dexie-react-hooks'
import { ExternalLink } from 'lucide-react'
import { type ReactNode, useId, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useStore } from 'zustand'
import { buttonClasses } from '../../components/ui/button'
import { REPOSITORY_URL } from '../connect/config'
import { useConnection } from '../connect/connection'
import { currentDevice } from '../connect/device'
import { getMoreLabel, reachSentence } from '../connect/explain'
import { ExperimentalChip } from '../connect/ui'
import { Dialog, DialogActions } from '../library/ui/dialog'
import { useSourcesSnapshot } from '../search/sources-context'
import { SettingsSection } from '../settings/settings-layout'
import { isConnected as isLibrarySyncOn } from '../sync/sync-store'
import { useAccountAccess, useAccountRuntime } from './context'
import { LIKED_NAME } from './ids'
import type { AccountRuntimeState, SyncFailure } from './runtime'
import { countCopies, readMeta, type SyncMeta } from './state'
import type { SyncProgress } from './sync'

/** Where the user signs in to Spotify in this browser. */
export const SPOTIFY_WEB_PLAYER_URL = 'https://open.spotify.com/'

/** Where problems with FXM, the Spotify account sync among them, can be reported. */
export const ISSUES_URL = `${REPOSITORY_URL}/issues`

/**
 * Why the sync is experimental, in plain words: its logged-in calls have run only against the
 * browser test's made-up Spotify, never a real account (the README's "Manual test with a real
 * account" is the owner's to run).
 */
export const EXPERIMENTAL_NOTE =
  'It has been tested with a stand-in for Spotify, not yet with real accounts.'

/** "1 song", "3 playlists", with grouping. */
function count(n: number, noun: string): string {
  return `${n.toLocaleString('en-GB')} ${noun}${n === 1 ? '' : 's'}`
}

/** When something happened, in a few words: "just now", "5 minutes ago", "at 14:05 on 3 Nov". */
export function whenText(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${count(minutes, 'minute')} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${count(hours, 'hour')} ago`
  const date = new Date(at)
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return `at ${time} on ${day}`
}

/** What the sync does right now, for its status line. */
export function progressText(progress: SyncProgress | undefined): string {
  switch (progress?.step) {
    case 'liked':
      return 'Syncing your liked songs…'
    case 'playlists':
      return progress.total !== undefined && progress.total > 0
        ? `Syncing your playlists: ${Math.min((progress.done ?? 0) + 1, progress.total)} of ${progress.total}…`
        : 'Syncing your playlists…'
    case 'home':
      return 'Syncing your home…'
    default:
      return 'Syncing…'
  }
}

/** The button that tries again: Sync now when connected, Try again after a failed check. */
export type RetryAction = 'Sync now' | 'Try again'

/**
 * Why the last sync failed, or the last login check, in words; `retry` is the button on screen
 * that tries again. `undefined` when there is nothing to add to the status above it.
 */
export function failureText(failure: SyncFailure, retry: RetryAction): string | undefined {
  switch (failure.kind) {
    case 'rate-limited':
      return 'Spotify asked FXM to slow down. FXM tries again later.'
    case 'secret':
      return "Spotify is paused: its web player's secret stopped working. FXM tries again later."
    case 'changed':
      return "Spotify answered in a way this version of FXM doesn't understand. An update of FXM will fix it."
    case 'network':
      return `FXM couldn't reach Spotify. Check your connection, then select ${retry}.`
    case 'storage':
      return "FXM couldn't save to your library: this browser's storage may be full or blocked."
    default:
      // After a failed check the status says so already.
      return retry === 'Sync now' ? 'The sync failed. Try again later.' : undefined
  }
}

/** What the last sync left in the library, in a sentence or two. */
export function syncedText(meta: SyncMeta, now: number): string | undefined {
  const { last, lastSyncAt: at } = meta
  if (last === undefined || at === undefined) return undefined
  const parts: string[] = []
  if (last.likedCopy) parts.push(`${LIKED_NAME} (${count(last.likedCount, 'song')})`)
  if (last.playlistCount > 0) parts.push(count(last.playlistCount, 'playlist'))
  const what = parts.length === 0 ? 'nothing to copy' : parts.join(' and ')
  const more =
    last.pending > 0
      ? ` ${count(last.pending, 'playlist')} ${last.pending === 1 ? 'waits' : 'wait'} for the next sync.`
      : ''
  const partial = last.complete ? '' : ' Some of it was too large to copy, or could not be read.'
  return `Last synced ${whenText(at, now)}: ${what}.${more}${partial}`
}

/** A link that opens in a new tab. */
function NewTabLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-semibold text-accent underline-offset-2 hover:underline"
    >
      {children}
      <ExternalLink aria-hidden="true" className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

const OPTIONS_HINT =
  'Open FXM Connect’s options from its button in the browser’s toolbar (or from the browser’s list of extensions)'

/** What the account's state means for the user, and what they can do. */
function PhaseText({
  state,
  platform,
  connectVersion,
}: {
  state: AccountRuntimeState
  platform: 'web' | 'desktop' | 'android'
  /** The FXM Connect version that answered, if any. */
  connectVersion: string | undefined
}): ReactNode {
  switch (state.phase) {
    case 'checking':
      return <p>Checking your Spotify login…</p>
    case 'connected':
      return state.displayName === undefined ? (
        <p>Connected.</p>
      ) : (
        <p>
          Connected as <strong className="text-text">{state.displayName}</strong>.
        </p>
      )
    case 'logged-out':
      return (
        <p>
          FXM Connect got no Spotify login from this browser. Sign in at{' '}
          <NewTabLink href={SPOTIFY_WEB_PLAYER_URL}>open.spotify.com</NewTabLink> in this browser,
          in a normal window, then select Try again. If you are signed in already, this browser may
          keep Spotify’s cookies from FXM Connect (some block them as third-party cookies).
        </p>
      )
    case 'needs-login':
      return (
        <>
          <p>
            FXM Connect doesn’t use your Spotify login yet. {OPTIONS_HINT}, turn on “Use my Spotify
            login from this browser” (in Firefox, also allow it to share authentication
            information), then select Try again.
          </p>
          {saysSpotifyLoginUnused(connectVersion) && (
            // FXM Connect 0.1.0's options page says the setting changes nothing: true before 3.5.
            <p>
              FXM Connect {connectVersion} says there that this setting changes nothing. That note
              dates from before FXM could connect an account: the setting works now, and newer
              versions of FXM Connect say so.
            </p>
          )}
        </>
      )
    case 'private':
      return (
        <p>
          FXM Connect never uses your Spotify login in private windows or container tabs. Open FXM
          in a normal window to sync.
        </p>
      )
    case 'unsupported':
      return (
        <p>
          {platform === 'android' ? 'The Android app' : 'The desktop app'} gets its own Spotify
          login later. Until then, connect your account in a browser with FXM Connect.
        </p>
      )
    case 'unreachable':
      return <p>Spotify can’t be reached here now, so FXM doesn’t sync.</p>
    case 'unverified':
      return <p>FXM couldn’t check your Spotify login just now.</p>
    default:
      return null
  }
}

/** The opt-in: what connecting does, and the risk, before anything happens. */
function ConnectDialog({
  open,
  librarySync,
  onClose,
  onConnect,
}: {
  open: boolean
  /** Whether library sync is on: the copies then go to the user's sync gist too. */
  librarySync: boolean
  onClose: () => void
  onConnect: () => void
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      alert
      title="Connect your Spotify account?"
      description="Read this first: it says what FXM does with your account, and the risk."
    >
      <div className="space-y-3 text-sm">
        <p>
          FXM reads your liked songs, your playlists and Spotify’s home for you, and keeps a copy of
          them in your library on this device. It never changes anything in your Spotify account. It
          syncs again about every six hours while FXM is open, and whenever you select Sync now.
        </p>
        <p>
          This is experimental. {EXPERIMENTAL_NOTE} If Spotify answers in a way FXM doesn’t
          understand, Settings says so, and FXM never takes an answer it can’t read for an empty
          list.
        </p>
        {librarySync ? (
          <p className="font-semibold">
            Sync with GitHub is on, so these copies, your private playlists included, also go to
            your sync gist on GitHub. Anyone with its link can read them there, and GitHub keeps
            every earlier version of it, also after you disconnect.
          </p>
        ) : (
          <p>
            If you turn on Sync with GitHub, these copies go to your sync gist there too, your
            private playlists included.
          </p>
        )}
        <p>
          FXM Connect asks Spotify for a login token with this browser’s Spotify login. The token
          stays in FXM’s memory and is never saved. FXM never sees your password or Spotify’s
          cookies.
        </p>
        <p className="font-semibold">
          Spotify’s User Guidelines forbid accessing Spotify by automated means, and Spotify may
          suspend or terminate an account that breaks them. No case is known of an account suspended
          for this kind of read-only use, but connect only if you accept that risk.
        </p>
      </div>
      <DialogActions>
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          className={buttonClasses({ variant: 'secondary' })}
        >
          Cancel
        </button>
        <button type="button" onClick={onConnect} className={buttonClasses()}>
          Connect
        </button>
      </DialogActions>
    </Dialog>
  )
}

/** Disconnecting: what stays and what goes. */
function DisconnectDialog({
  open,
  copies,
  librarySync,
  onClose,
  onDisconnect,
}: {
  open: boolean
  copies: number
  /** Whether library sync is on: the copies are in the user's sync gist too. */
  librarySync: boolean
  onClose: () => void
  onDisconnect: (removeCopies: boolean) => void
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      alert
      title="Disconnect your Spotify account?"
      description={
        copies > 0
          ? `FXM forgets your Spotify login token at once and stops syncing. Your library keeps the ${count(copies, 'playlist')} it synced, as ordinary playlists.`
          : 'FXM forgets your Spotify login token at once and stops syncing.'
      }
    >
      <DisconnectChoices
        copies={copies}
        librarySync={librarySync}
        onClose={onClose}
        onDisconnect={onDisconnect}
      />
    </Dialog>
  )
}

/** The dialog's choices, fresh each time it opens (the dialog mounts them only while open). */
function DisconnectChoices({
  copies,
  librarySync,
  onClose,
  onDisconnect,
}: {
  copies: number
  librarySync: boolean
  onClose: () => void
  onDisconnect: (removeCopies: boolean) => void
}) {
  const [removeCopies, setRemoveCopies] = useState(false)
  const checkboxId = useId()
  const helpId = useId()
  return (
    <>
      <div className="space-y-4 text-sm">
        {copies > 0 && (
          <div className="flex items-start gap-3">
            <input
              id={checkboxId}
              type="checkbox"
              checked={removeCopies}
              aria-describedby={helpId}
              onChange={(event) => setRemoveCopies(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-accent"
            />
            <div className="space-y-1">
              <label htmlFor={checkboxId} className="font-semibold">
                Also remove the synced playlists you haven’t changed
              </label>
              <p id={helpId} className="text-text-muted">
                Playlists you changed in FXM stay either way.
              </p>
            </div>
          </div>
        )}
        {copies > 0 && librarySync && (
          <p className="text-text-muted">
            Your sync gist on GitHub keeps them in its earlier versions, even once you remove them
            here.
          </p>
        )}
        <p className="text-text-muted">
          To stop FXM Connect from using your Spotify login at all, also turn off “Use my Spotify
          login from this browser” in its options.
        </p>
      </div>
      <DialogActions>
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          className={buttonClasses({ variant: 'secondary' })}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onDisconnect(removeCopies)}
          className={buttonClasses({ variant: 'danger' })}
        >
          Disconnect
        </button>
      </DialogActions>
    </>
  )
}

/**
 * Settings → Spotify account (stage 3.5): connect the account after its notice, see what the
 * sync did, sync now, disconnect.
 */
export function SpotifyAccountSettings() {
  const access = useAccountAccess()
  const optedIn = useStore(access.choice, (state) => state.optedIn)
  const { spotifyEnabled } = useSourcesSnapshot()
  const capabilities = useConnection((state) => state.capabilities)
  const platform = useConnection((state) => state.platform)
  const connectVersion = useConnection((state) => state.connect?.version)
  const librarySync = useStore(access.librarySync, isLibrarySyncOn)
  const { runtime, state, error: loadError } = useAccountRuntime(optedIn)
  // Only the sync's own row: a sync rewrites the rows of its copies as it goes.
  const synced = useLiveQuery(
    () => (optedIn ? readMeta(access.library()).catch(() => undefined) : undefined),
    [optedIn, access],
  )
  const [dialog, setDialog] = useState<'connect' | 'disconnect' | null>(null)
  /** The copies the sync follows, counted when Disconnect's dialog opens. */
  const [copies, setCopies] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const headingId = useId()
  const now = Date.now()
  const device = useMemo(currentDevice, [])

  const connect = async () => {
    setDialog(null)
    setBusy(true)
    setMessage('')
    try {
      const loaded = runtime ?? (await access.load())
      await loaded.connect()
    } catch {
      setMessage('FXM couldn’t start the Spotify account here. Reload the page and try again.')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (removeCopies: boolean) => {
    setDialog(null)
    setBusy(true)
    try {
      const loaded = runtime ?? (await access.load())
      const result = await loaded.disconnect({ removeCopies })
      setMessage(
        result.removed > 0
          ? `Disconnected. FXM removed ${count(result.removed, 'synced playlist')}${result.kept > 0 ? ` and kept ${count(result.kept, 'playlist')} you changed` : ''}.`
          : 'Disconnected. Your library keeps what FXM synced.',
      )
    } catch {
      // The account is off (the choice went first); only forgetting what was synced failed.
      access.choice.getState().setOptedIn(false)
      setMessage('Disconnected, but FXM couldn’t tidy up your library. Try again later.')
    } finally {
      setBusy(false)
    }
  }

  const openDisconnect = async () => {
    // Counted now: a sync may have made copies since the last one ended.
    setCopies(await countCopies(access.library()).catch(() => 0))
    setDialog('disconnect')
  }

  const last = synced?.last
  const hasCopies = last !== undefined && (last.likedCopy || last.playlistCount > 0)
  const reachable = spotifyEnabled && capabilities.spotify !== 'unreachable'

  let status: ReactNode
  let actions: ReactNode = null
  if (!optedIn) {
    if (!spotifyEnabled) {
      status = <p>Switch Spotify on, above, to connect your account.</p>
    } else if (capabilities.spotify === 'unreachable') {
      // What this device can do about it: FXM Connect where its browser can add it, else what
      // works here (nothing to install on iPhone and iPad, the Android app once it is out).
      status = (
        <p>
          Connecting your account needs Spotify. {reachSentence('Spotify', device)}{' '}
          <Link
            to="/connect"
            className="font-semibold text-accent underline-offset-2 hover:underline"
          >
            {getMoreLabel(device)}
          </Link>
        </p>
      )
    } else if (platform !== 'web' && capabilities.spotify !== 'account') {
      status = (
        <p>
          {platform === 'android' ? 'The Android app' : 'The desktop app'} gets its own Spotify
          login later. Until then, connect your account in a browser with FXM Connect.
        </p>
      )
    } else {
      status = (
        <p>
          Off. Connect your Spotify account to sync your liked songs, your playlists and Spotify’s
          home for you into your library, read-only.
        </p>
      )
      actions = (
        <button
          type="button"
          disabled={busy}
          onClick={() => setDialog('connect')}
          className={buttonClasses()}
        >
          Connect your account
        </button>
      )
    }
  } else {
    // A failure means something where a button tries again: Sync now, or Try again after a
    // failed check. Elsewhere the status says what to do, and a sync's old failure would mislead.
    const retry: RetryAction | undefined =
      !reachable || loadError !== undefined
        ? undefined
        : state.phase === 'connected'
          ? 'Sync now'
          : state.phase === 'unverified'
            ? 'Try again'
            : undefined
    const failureLine =
      state.failure === undefined || retry === undefined
        ? undefined
        : failureText(state.failure, retry)
    const syncedLine = synced === undefined ? undefined : syncedText(synced, now)
    status = (
      <>
        {loadError !== undefined ? (
          <p>FXM couldn’t start the Spotify account here. Reload the page and try again.</p>
        ) : !reachable ? (
          <p>
            {spotifyEnabled
              ? 'Spotify can’t be reached here now, so FXM doesn’t sync. It goes on where FXM Connect works.'
              : 'Spotify is switched off, so FXM doesn’t sync.'}
          </p>
        ) : (
          <PhaseText state={state} platform={platform} connectVersion={connectVersion} />
        )}
        {state.syncing ? (
          <p>{progressText(state.progress)}</p>
        ) : (
          syncedLine !== undefined && <p>{syncedLine}</p>
        )}
        {state.syncingElsewhere && !state.syncing && <p>Another FXM tab is syncing right now.</p>}
        {failureLine !== undefined && !state.syncing && (
          <p className="font-semibold text-danger">{failureLine}</p>
        )}
        {hasCopies && (
          <p>
            <Link
              to="/library?tab=playlists"
              className="font-semibold text-accent underline-offset-2 hover:underline"
            >
              Open your playlists
            </Link>
          </p>
        )}
      </>
    )
    const loginProblem =
      state.phase === 'logged-out' ||
      state.phase === 'needs-login' ||
      state.phase === 'private' ||
      state.phase === 'unverified'
    actions = (
      <div className="flex flex-wrap gap-3">
        {state.phase === 'connected' && reachable && (
          <button
            type="button"
            aria-disabled={state.syncing || busy}
            onClick={() => {
              if (state.syncing || busy || runtime === undefined) return
              void runtime.syncNow()
            }}
            className={buttonClasses()}
          >
            {state.syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
        {loginProblem && reachable && (
          <button type="button" onClick={() => void runtime?.recheck()} className={buttonClasses()}>
            Try again
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void openDisconnect()}
          className={buttonClasses({ variant: 'secondary' })}
        >
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <SettingsSection title="Spotify account">
      <section aria-labelledby={headingId} className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1 basis-64 space-y-1">
            <h3
              id={headingId}
              className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold"
            >
              <span>Your Spotify account</span>
              <ExperimentalChip />
            </h3>
            <div aria-live="polite" className="space-y-1 text-sm text-text-muted">
              {status}
              {message !== '' && <p className="text-text">{message}</p>}
            </div>
          </div>
          {actions}
        </div>
        <p className="text-sm text-text-muted">
          Connecting your account is experimental. {EXPERIMENTAL_NOTE} If something goes wrong,{' '}
          <NewTabLink href={ISSUES_URL}>report it on GitHub</NewTabLink>.
        </p>
      </section>
      <ConnectDialog
        open={dialog === 'connect'}
        librarySync={librarySync}
        onClose={() => setDialog(null)}
        onConnect={() => void connect()}
      />
      <DisconnectDialog
        open={dialog === 'disconnect'}
        copies={copies}
        librarySync={librarySync}
        onClose={() => setDialog(null)}
        onDisconnect={(removeCopies) => void disconnect(removeCopies)}
      />
    </SettingsSection>
  )
}
