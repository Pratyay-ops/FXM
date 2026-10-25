import { isFxmError } from '@fxm/core'
import {
  isLastfmKey,
  isListenBrainzToken,
  LASTFM_API_ACCOUNT_URL,
  LASTFM_APPLICATIONS_URL,
  LASTFM_ERRORS,
  type LastfmCredentials,
  LISTENBRAINZ_SETTINGS_URL,
  SCROBBLE_SERVICE_NAMES,
  ScrobbleError,
  type ScrobbleServiceId,
  type ScrobbleServiceStatus,
} from '@fxm/sources/scrobble'
import { useLiveQuery } from 'dexie-react-hooks'
import { ExternalLink } from 'lucide-react'
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { buttonClasses } from '../../components/ui/button'
import { TextField } from '../library/ui/field'
import { SettingsSection } from '../settings/settings-layout'
import {
  getScrobbler,
  getScrobbleStore,
  lastfmClientFor,
  listenBrainzClientFor,
  scrobbleContext,
} from './scrobbling'
import { useScrobblingStore } from './scrobbling-store'

/** How many scrobbles wait in `service`'s queue, live across tabs; 0 when not `enabled`. */
function usePending(service: ScrobbleServiceId, enabled: boolean): number {
  const count = useLiveQuery(async () => {
    if (!enabled) return 0
    try {
      return await getScrobbleStore().count(service)
    } catch {
      return 0
    }
  }, [service, enabled])
  return count ?? 0
}

/** How sending to `service` goes in this tab, updated as it changes. */
function useSendingStatus(service: ScrobbleServiceId): ScrobbleServiceStatus {
  const scrobbler = getScrobbler()
  const [, setVersion] = useState(0)
  useEffect(() => scrobbler.subscribe(() => setVersion((version) => version + 1)), [scrobbler])
  return scrobbler.status(service)
}

function subscribeToNetwork(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/** Whether the browser says it is online, updated as that changes. */
function useOnline(): boolean {
  return useSyncExternalStore(subscribeToNetwork, () => navigator.onLine !== false)
}

/** "1 listen", "3 scrobbles". */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** A time of day, for when the next try is due. */
function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** What waits to be sent, and when it goes, for a connected service's status line. */
function pendingText(
  pending: number,
  noun: string,
  status: ScrobbleServiceStatus,
  online: boolean,
): string {
  if (pending === 0) return ''
  const waiting = `${count(pending, noun)} waiting to be sent`
  if (!online) return `${waiting} once you are back online.`
  if (status.retryAt !== undefined && status.retryAt > Date.now()) {
    return `${waiting}. The last try failed; FXM tries again at ${timeOfDay(status.retryAt)}.`
  }
  return `${waiting}.`
}

/** Why connecting failed, in words, for a failure that isn't the credentials'. */
function failureText(service: ScrobbleServiceId, failure: unknown): string {
  const name = SCROBBLE_SERVICE_NAMES[service]
  if (failure instanceof ScrobbleError && failure.failure === 'rate-limited') {
    return `${name} asked FXM to slow down. Try again in a minute.`
  }
  if (isFxmError(failure, 'Network')) {
    return `FXM couldn't reach ${name}. Check your connection and try again.`
  }
  return `${name} didn't answer as expected. Try again later.`
}

/** A link to a service's page, opening in a new tab. */
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

/** One service: its name and status, the main action beside them, and its forms below. */
function ServiceRow({
  name,
  status,
  action,
  children,
}: {
  name: string
  status: ReactNode
  action?: ReactNode
  children?: ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        {/* Shrinks to keep the action beside it, down to 16rem; narrower screens stack them. */}
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <h3 id={headingId} className="font-semibold">
            {name}
          </h3>
          <div aria-live="polite" className="space-y-1 text-sm text-text-muted">
            {status}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function ErrorText({ children }: { children: string }) {
  return children === '' ? null : (
    <p role="alert" className="text-sm font-semibold text-danger">
      {children}
    </p>
  )
}

function ListenBrainzRow() {
  const account = useScrobblingStore((state) => state.listenbrainz)
  const pending = usePending('listenbrainz', account !== undefined)
  const status = useSendingStatus('listenbrainz')
  const online = useOnline()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const connect = async (event: FormEvent) => {
    event.preventDefault()
    const value = token.trim()
    if (!isListenBrainzToken(value)) {
      setError(
        "That doesn't look like a ListenBrainz user token. Copy it again from your settings.",
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      const check = await listenBrainzClientFor(value).validateToken(scrobbleContext())
      if (!check.valid) {
        setError("ListenBrainz doesn't accept this token. Copy it again from your settings.")
        return
      }
      // Listens waiting for another user's account are not this one's to send.
      const previous = useScrobblingStore.getState().listenbrainz
      if (previous !== undefined && previous.userName !== check.userName) {
        await getScrobbler().forget('listenbrainz')
      }
      useScrobblingStore.getState().connectListenBrainz({ token: value, userName: check.userName })
      setToken('')
    } catch (failure) {
      setError(failureText('listenbrainz', failure))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setError('')
    useScrobblingStore.getState().disconnect('listenbrainz')
    await getScrobbler().forget('listenbrainz')
  }

  const refused = account?.refusedAt !== undefined
  const form = (
    <form onSubmit={connect} className="space-y-3">
      <TextField
        label="User token"
        hint="It stays on this device, and goes only to ListenBrainz."
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(event) => setToken(event.target.value)}
        className="max-w-md"
      />
      <button type="submit" disabled={busy || token.trim() === ''} className={buttonClasses()}>
        {busy ? 'Checking the token…' : refused ? 'Use this token' : 'Connect'}
      </button>
      <ErrorText>{error}</ErrorText>
    </form>
  )

  if (account === undefined) {
    return (
      <ServiceRow
        name="ListenBrainz"
        status={
          <p>
            Off. Paste the user token from your{' '}
            <NewTabLink href={LISTENBRAINZ_SETTINGS_URL}>ListenBrainz settings</NewTabLink> to add
            the songs you play to your ListenBrainz profile, which is public.
          </p>
        }
      >
        {form}
      </ServiceRow>
    )
  }
  const waiting = pendingText(pending, 'listen', status, online)
  return (
    <ServiceRow
      name="ListenBrainz"
      status={
        refused ? (
          <>
            <p className="font-semibold text-danger">
              Paused: ListenBrainz no longer accepts the token. Paste a new one to send the songs
              you play again.
            </p>
            {pending > 0 && <p>{count(pending, 'listen')} waiting.</p>}
          </>
        ) : (
          <>
            <p>
              On: the songs you play go to the ListenBrainz profile of{' '}
              <strong className="text-text">{account.userName}</strong>.
            </p>
            {waiting !== '' && <p>{waiting}</p>}
          </>
        )
      }
      action={
        <button
          type="button"
          onClick={disconnect}
          className={buttonClasses({ variant: 'secondary' })}
        >
          Disconnect
        </button>
      }
    >
      {refused ? form : <ErrorText>{error}</ErrorText>}
    </ServiceRow>
  )
}

/** A Last.fm authorization in progress: the request token, waiting for the user to allow it. */
interface Authorization {
  credentials: LastfmCredentials
  token: string
  url: string
  /** Whether the user opened Last.fm's page, so coming back here may finish. */
  opened: boolean
}

function LastfmRow() {
  const account = useScrobblingStore((state) => state.lastfm)
  const pending = usePending('lastfm', account !== undefined)
  const status = useSendingStatus('lastfm')
  const online = useOnline()
  const [apiKey, setApiKey] = useState('')
  const [secret, setSecret] = useState('')
  const [authorization, setAuthorization] = useState<Authorization | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const finishing = useRef(false)

  /** Step 1: a request token for the user's API account, and the page that allows it. */
  const start = async (credentials: LastfmCredentials) => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const client = lastfmClientFor(credentials)
      const token = await client.getToken(scrobbleContext())
      setAuthorization({ credentials, token, url: client.authorizeUrl(token), opened: false })
    } catch (failure) {
      setError(
        failure instanceof ScrobbleError && failure.failure === 'refused'
          ? "Last.fm doesn't accept this API key and shared secret. Copy them again from your API account."
          : failureText('lastfm', failure),
      )
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const credentials = { apiKey: apiKey.trim(), secret: secret.trim() }
    if (!isLastfmKey(credentials.apiKey) || !isLastfmKey(credentials.secret)) {
      setError(
        'An API key and a shared secret are 32 letters and digits each. Copy them again from your API account.',
      )
      return
    }
    void start(credentials)
  }

  /** Step 3: the session, once the user allowed the token. `quiet` keeps a not-yet quiet. */
  const finish = useCallback(
    async (quiet: boolean) => {
      if (authorization === null || finishing.current) return
      finishing.current = true
      setBusy(true)
      setError('')
      try {
        const { credentials, token } = authorization
        const session = await lastfmClientFor(credentials).getSession(token, scrobbleContext())
        // Scrobbles waiting for another user's account are not this one's to send.
        const previous = useScrobblingStore.getState().lastfm
        if (previous !== undefined && previous.userName !== session.userName) {
          await getScrobbler().forget('lastfm')
        }
        useScrobblingStore.getState().connectLastfm({ ...credentials, ...session })
        setAuthorization(null)
        setApiKey('')
        setSecret('')
        setNote('')
      } catch (failure) {
        const code = failure instanceof ScrobbleError ? failure.serviceCode : undefined
        if (code === LASTFM_ERRORS.tokenNotAuthorized) {
          if (!quiet) setNote("Last.fm hasn't been told yet that FXM may use your profile.")
        } else if (
          code === LASTFM_ERRORS.tokenExpired ||
          code === LASTFM_ERRORS.authenticationFailed
        ) {
          setAuthorization(null)
          setError('That request expired. Connect again.')
        } else {
          setError(failureText('lastfm', failure))
        }
      } finally {
        finishing.current = false
        setBusy(false)
      }
    },
    [authorization],
  )

  // Coming back to this tab after allowing access on Last.fm finishes by itself.
  useEffect(() => {
    if (authorization === null || !authorization.opened) return
    const onFocus = () => void finish(true)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void finish(true)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [authorization, finish])

  const disconnect = async () => {
    setError('')
    setAuthorization(null)
    useScrobblingStore.getState().disconnect('lastfm')
    await getScrobbler().forget('lastfm')
  }

  const disconnectButton = account !== undefined && (
    <button type="button" onClick={disconnect} className={buttonClasses({ variant: 'secondary' })}>
      Disconnect
    </button>
  )

  if (authorization !== null) {
    return (
      <ServiceRow
        name="Last.fm"
        status={<p>Almost there: allow your API account to use your Last.fm profile.</p>}
        action={disconnectButton}
      >
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Open Last.fm, sign in if it asks, and allow access.</li>
          <li>Come back here. FXM finishes connecting by itself, or press Done.</li>
        </ol>
        <div className="flex flex-wrap gap-3">
          <a
            href={authorization.url}
            target="_blank"
            rel="noreferrer"
            onClick={() => setAuthorization({ ...authorization, opened: true })}
            className={buttonClasses()}
          >
            Open Last.fm
            <ExternalLink aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <button
            type="button"
            disabled={busy}
            onClick={() => void finish(false)}
            className={buttonClasses({ variant: 'secondary' })}
          >
            {busy ? 'Checking…' : 'Done'}
          </button>
          <button
            type="button"
            onClick={() => {
              setAuthorization(null)
              setNote('')
            }}
            className={buttonClasses({ variant: 'ghost' })}
          >
            Cancel
          </button>
        </div>
        {note !== '' && <p className="text-sm text-text-muted">{note}</p>}
        <ErrorText>{error}</ErrorText>
      </ServiceRow>
    )
  }

  if (account === undefined) {
    return (
      <ServiceRow
        name="Last.fm"
        status={
          <p>
            Off. Last.fm asks every app for an API account of its own, so{' '}
            <NewTabLink href={LASTFM_API_ACCOUNT_URL}>create one</NewTabLink> (any name works, and
            FXM needs no callback URL), then enter its API key and shared secret here.
          </p>
        }
      >
        <form onSubmit={submit} className="space-y-3">
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <TextField
              label="API key"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <TextField
              label="Shared secret"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </div>
          <p className="text-xs text-text-muted">
            Both stay on this device. The secret is never sent: it only signs FXM's requests to
            Last.fm.
          </p>
          <button
            type="submit"
            disabled={busy || apiKey.trim() === '' || secret.trim() === ''}
            className={buttonClasses()}
          >
            {busy ? 'Asking Last.fm…' : 'Connect'}
          </button>
          <ErrorText>{error}</ErrorText>
        </form>
      </ServiceRow>
    )
  }

  const refused = account.refusedAt !== undefined
  const waiting = pendingText(pending, 'scrobble', status, online)
  return (
    <ServiceRow
      name="Last.fm"
      status={
        refused ? (
          <>
            <p className="font-semibold text-danger">
              Paused: Last.fm no longer accepts FXM's session. Connect again to send the songs you
              play.
            </p>
            {pending > 0 && <p>{count(pending, 'scrobble')} waiting.</p>}
          </>
        ) : (
          <>
            <p>
              On: the songs you play go to the Last.fm profile of{' '}
              <strong className="text-text">{account.userName}</strong>.
            </p>
            {waiting !== '' && <p>{waiting}</p>}
          </>
        )
      }
      action={disconnectButton}
    >
      {refused && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void start({ apiKey: account.apiKey, secret: account.secret })}
          className={buttonClasses()}
        >
          {busy ? 'Asking Last.fm…' : 'Connect again'}
        </button>
      )}
      <p className="text-xs text-text-muted">
        Disconnecting makes FXM forget the key, the secret and the session. To end the session at
        Last.fm too, remove the app in your{' '}
        <NewTabLink href={LASTFM_APPLICATIONS_URL}>Last.fm application settings</NewTabLink>.
      </p>
      <ErrorText>{error}</ErrorText>
    </ServiceRow>
  )
}

/**
 * Settings → Scrobbling: connect ListenBrainz and Last.fm, see what waits to be sent, and
 * disconnect. Off until the user connects an account.
 */
export function ScrobblingSettings() {
  return (
    <SettingsSection title="Scrobbling">
      <p className="p-4 text-sm text-text-muted sm:px-5">
        Add the songs you play to your profile on ListenBrainz or Last.fm: a song counts once you
        have heard half of it, or 4 minutes. Nothing is sent until you connect an account, and songs
        played offline are sent later.
      </p>
      <ListenBrainzRow />
      <LastfmRow />
    </SettingsSection>
  )
}
