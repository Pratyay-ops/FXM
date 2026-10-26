import { useLiveQuery } from 'dexie-react-hooks'
import { ExternalLink } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { Link } from 'react-router'
import { useStore } from 'zustand'
import { buttonClasses } from '../../components/ui/button'
import { useConnection } from '../connect/connection'
import { Dialog, DialogActions } from '../library/ui/dialog'
import { useSourcesSnapshot } from '../search/sources-context'
import { SettingsSection } from '../settings/settings-layout'
import { isConnected as isLibrarySyncOn } from '../sync/sync-store'
import { useAccountAccess, useAccountRuntime } from './context'
import { LIKED_NAME } from './ids'
import type { AccountRuntimeState, DisconnectResult, LoginOutcome, SyncFailure } from './runtime'
import { countCopies, readMeta, type SyncMeta } from './state'
import type { SyncProgress } from './sync'

/** Where the user signs in to Spotify in this browser. */
export const SPOTIFY_WEB_PLAYER_URL = 'https://open.spotify.com/'

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

/** Why the Android app's login window couldn't help, after Connect or Log in. */
export const LOGIN_FAILED =
  'FXM couldn’t open its Spotify login window, or couldn’t keep the login on this phone. Try again.'

/** Why the Android app's login window didn't open at all, after Connect or Log in. */
export const LOGIN_UNAVAILABLE = 'FXM can’t open its Spotify login window on this phone.'

/** Why logging out of Spotify on the phone failed. */
export const LOGOUT_FAILED = 'FXM couldn’t delete its Spotify login on this phone. Try again.'

/** What Settings says after Connect or Log in opened the login window, if anything. */
function loginText(outcome: LoginOutcome | undefined): string {
  if (outcome === 'failed') return LOGIN_FAILED
  if (outcome === 'unavailable') return LOGIN_UNAVAILABLE
  return ''
}

/** What Disconnect did, in a sentence or two: to the library, and to the app's own login. */
export function disconnectedText(result: DisconnectResult): string {
  const done =
    result.loginKept === true
      ? 'Disconnected, but FXM couldn’t delete its Spotify login on this phone'
      : result.loginKept === false
        ? 'Disconnected and logged out of Spotify on this phone'
        : 'Disconnected'
  const library =
    result.removed > 0
      ? `FXM removed ${count(result.removed, 'synced playlist')}${result.kept > 0 ? ` and kept ${count(result.kept, 'playlist')} you changed` : ''}.`
      : 'Your library keeps what FXM synced.'
  const retry = result.loginKept === true ? ' Select Log out of Spotify to try again.' : ''
  return `${done}. ${library}${retry}`
}

/** Where the Android app stands without a Spotify login: it logs in through its own window. */
function AndroidLoggedOut() {
  return (
    <p>
      You’re not logged in to Spotify in FXM. Select Log in to Spotify: Spotify’s own login page
      opens in a window of FXM’s, and FXM never sees your password. Google and Facebook don’t allow
      signing in there; if you use one of them for Spotify, the window says what to do instead.
    </p>
  )
}

/** What the account's state means for the user, and what they can do. */
function PhaseText({
  state,
  platform,
}: {
  state: AccountRuntimeState
  platform: 'web' | 'desktop' | 'android'
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
      if (platform === 'android') return <AndroidLoggedOut />
      return (
        <p>
          FXM Connect got no Spotify login from this browser. Sign in at{' '}
          <NewTabLink href={SPOTIFY_WEB_PLAYER_URL}>open.spotify.com</NewTabLink> in this browser,
          in a normal window, then select Try again. If you are signed in already, this browser may
          keep Spotify’s cookies from FXM Connect (some block them as third-party cookies).
        </p>
      )
    case 'needs-login':
      if (platform === 'android') return <AndroidLoggedOut />
      return (
        <p>
          FXM Connect doesn’t use your Spotify login yet. {OPTIONS_HINT}, turn on “Use my Spotify
          login from this browser” (in Firefox, also allow it to share authentication information),
          then select Try again.
        </p>
      )
    case 'private':
      return (
        <p>
          FXM Connect never uses your Spotify login in private windows or container tabs. Open FXM
          in a normal window to sync.
        </p>
      )
    case 'unsupported':
      if (platform === 'android') {
        return (
          <p>
            This phone’s WebView can’t keep FXM’s Spotify login apart from the app, so FXM doesn’t
            open its login window. Update Android System WebView from the Play Store, then select
            Try again.
          </p>
        )
      }
      return (
        <p>
          The desktop app gets its own Spotify login later. Until then, connect your account in a
          browser with FXM Connect.
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
  platform,
  onClose,
  onConnect,
}: {
  open: boolean
  /** Whether library sync is on: the copies then go to the user's sync gist too. */
  librarySync: boolean
  platform: 'web' | 'desktop' | 'android'
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
        {platform === 'android' ? (
          <p>
            Next, Spotify’s own login page opens in a window of FXM’s, where you log in. FXM never
            sees your password. It keeps the login Spotify gives that window, encrypted on this
            phone, and uses it only to ask Spotify for a login token. The token stays in FXM’s
            memory and is never saved. Google and Facebook don’t allow signing in there.
          </p>
        ) : (
          <p>
            FXM Connect asks Spotify for a login token with this browser’s Spotify login. The token
            stays in FXM’s memory and is never saved. FXM never sees your password or Spotify’s
            cookies.
          </p>
        )}
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
  platform,
  onClose,
  onDisconnect,
}: {
  open: boolean
  copies: number
  /** Whether library sync is on: the copies are in the user's sync gist too. */
  librarySync: boolean
  platform: 'web' | 'desktop' | 'android'
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
        platform={platform}
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
  platform,
  onClose,
  onDisconnect,
}: {
  copies: number
  librarySync: boolean
  platform: 'web' | 'desktop' | 'android'
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
        {platform === 'android' ? (
          <p className="text-text-muted">
            FXM also logs out of Spotify on this phone: it deletes the login it kept and its login
            window’s cookies. Your Spotify account stays logged in elsewhere.
          </p>
        ) : (
          <p className="text-text-muted">
            To stop FXM Connect from using your Spotify login at all, also turn off “Use my Spotify
            login from this browser” in its options.
          </p>
        )}
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
  const librarySync = useStore(access.librarySync, isLibrarySyncOn)
  // The Android app's own login can outlive the account (a Disconnect that couldn't delete it),
  // and only the runtime can tell, by asking the app: built there even while the account is off.
  const { runtime, state, error: loadError } = useAccountRuntime(optedIn || platform === 'android')
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

  const connect = async () => {
    setDialog(null)
    setBusy(true)
    setMessage('')
    try {
      const loaded = runtime ?? (await access.load())
      // On Android this also opens the login window when no login is kept.
      setMessage(loginText(await loaded.connect()))
    } catch {
      setMessage('FXM couldn’t start the Spotify account here. Reload the page and try again.')
    } finally {
      setBusy(false)
    }
  }

  const logIn = async () => {
    if (runtime === undefined || busy) return
    setBusy(true)
    setMessage('')
    try {
      setMessage(loginText(await runtime.login()))
    } finally {
      setBusy(false)
    }
  }

  const logOut = async () => {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      const loaded = runtime ?? (await access.load())
      const kept = await loaded.logout()
      setMessage(kept === true ? LOGOUT_FAILED : 'Logged out of Spotify on this phone.')
    } catch {
      setMessage(LOGOUT_FAILED)
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (removeCopies: boolean) => {
    setDialog(null)
    setBusy(true)
    try {
      const loaded = runtime ?? (await access.load())
      // On Android, Disconnect logs out of the app's own login too, and says when it couldn't.
      setMessage(disconnectedText(await loaded.disconnect({ removeCopies })))
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
      status = (
        <p>
          Connecting your account needs Spotify, which FXM reaches in a browser with FXM Connect.{' '}
          <Link
            to="/connect"
            className="font-semibold text-accent underline-offset-2 hover:underline"
          >
            Get FXM Connect
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
    if (state.loginKept === true) {
      // The app's own login outlived the account: a Disconnect that couldn't delete it.
      status = (
        <>
          {status}
          <p>FXM still keeps a Spotify login on this phone.</p>
        </>
      )
      actions = (
        <div className="flex flex-wrap gap-3">
          {actions}
          <button
            type="button"
            disabled={busy}
            onClick={() => void logOut()}
            className={buttonClasses({ variant: 'secondary' })}
          >
            Log out of Spotify
          </button>
        </div>
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
          <PhaseText state={state} platform={platform} />
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
    // On Android a missing login takes the login window, not another look at the browser's.
    const logInHere =
      platform === 'android' && (state.phase === 'logged-out' || state.phase === 'needs-login')
    const loginProblem =
      !logInHere &&
      (state.phase === 'logged-out' ||
        state.phase === 'needs-login' ||
        state.phase === 'private' ||
        state.phase === 'unverified' ||
        (platform === 'android' && state.phase === 'unsupported'))
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
        {logInHere && reachable && (
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => void logIn()}
            className={buttonClasses()}
          >
            Log in to Spotify
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
            <h3 id={headingId} className="font-semibold">
              Your Spotify account
            </h3>
            <div aria-live="polite" className="space-y-1 text-sm text-text-muted">
              {status}
              {message !== '' && <p className="text-text">{message}</p>}
            </div>
          </div>
          {actions}
        </div>
      </section>
      <ConnectDialog
        open={dialog === 'connect'}
        librarySync={librarySync}
        platform={platform}
        onClose={() => setDialog(null)}
        onConnect={() => void connect()}
      />
      <DisconnectDialog
        open={dialog === 'disconnect'}
        copies={copies}
        librarySync={librarySync}
        platform={platform}
        onClose={() => setDialog(null)}
        onDisconnect={(removeCopies) => void disconnect(removeCopies)}
      />
    </SettingsSection>
  )
}
