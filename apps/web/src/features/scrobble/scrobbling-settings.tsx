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
import { ExternalLink, Eye, EyeOff } from 'lucide-react'
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
import { IconButton } from '../../components/ui/icon-button'
import { cn } from '../../lib/cn'
import { TextField } from '../library/ui/field'
import { SettingsSection } from '../settings/settings-layout'
import {
  forgetQueue,
  getScrobbler,
  getScrobbleStore,
  lastfmClientFor,
  listenBrainzClientFor,
  scrobbleContext,
} from './scrobbling'
import { useScrobblingStore } from './scrobbling-store'

/**
 * How many scrobbles wait in `service`'s queue, live across tabs: 0 when not `enabled`, and
 * `null` when the store can't say (storage blocked).
 */
function usePending(service: ScrobbleServiceId, enabled: boolean): number | null {
  const count = useLiveQuery(async () => {
    if (!enabled) return 0
    try {
      return await getScrobbleStore().count(service)
    } catch {
      return null
    }
  }, [service, enabled])
  return count === undefined ? 0 : count
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

/**
 * What a service's queue holds, in the store and in memory, and whether the device can save
 * scrobbles, for its status lines.
 */
function useQueue(service: ScrobbleServiceId, enabled: boolean) {
  const stored = usePending(service, enabled)
  const status = useSendingStatus(service)
  return {
    status,
    waiting: (stored ?? 0) + status.unsaved,
    storageFailed: status.storageError !== undefined || stored === null,
  }
}

/** Says that this device can't save scrobbles, while it can't. */
function StorageWarning({ noun }: { noun: string }) {
  return (
    <p className="font-semibold text-danger">
      FXM can't save {noun}s on this device: its storage is full or blocked. The songs you play are
      still sent while FXM is open, but any not yet sent when it closes are lost.
    </p>
  )
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

/**
 * The markers password managers read to leave a field alone (1Password, LastPass, Bitwarden,
 * Dashlane), on top of `autocomplete="off"`, which they may ignore.
 */
const NOT_A_LOGIN = {
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const

/**
 * A field for a token or a secret. It is a text field whose characters show as dots until the
 * user shows them, not a password field: browsers offer to save what a password field held once
 * its form is done, and to sync it to the user's account, but these must stay on this device.
 */
function SecretField({
  label,
  hint,
  value,
  onChange,
  className,
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  const id = useId()
  const hintId = useId()
  const [shown, setShown] = useState(false)
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          {...NOT_A_LOGIN}
          id={id}
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={hint === undefined ? undefined : hintId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            'h-touch w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 text-base text-text placeholder:text-text-muted',
            !shown && '[-webkit-text-security:disc]',
          )}
        />
        <IconButton
          label={`Show the ${label.toLowerCase()}`}
          pressed={shown}
          icon={shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          onClick={() => setShown(!shown)}
        />
      </div>
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      )}
    </div>
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
  const { status, waiting, storageFailed } = useQueue('listenbrainz', account !== undefined)
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
      // Listens queued for another user, or left by an account disconnected before, are not
      // this one's to send.
      if (useScrobblingStore.getState().listenbrainz?.userName !== check.userName) {
        await forgetQueue('listenbrainz')
      }
      useScrobblingStore.getState().connectListenBrainz({ token: value, userName: check.userName })
      setToken('')
    } catch (failure) {
      setError(failureText('listenbrainz', failure))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = () => {
    setError('')
    useScrobblingStore.getState().disconnect('listenbrainz')
    void forgetQueue('listenbrainz')
  }

  const refused = account?.refusedAt !== undefined
  const form = (
    <form onSubmit={connect} autoComplete="off" className="space-y-3">
      <SecretField
        label="User token"
        hint="It stays on this device, and goes only to ListenBrainz."
        value={token}
        onChange={setToken}
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
  const waitingText = pendingText(waiting, 'listen', status, online)
  return (
    <ServiceRow
      name="ListenBrainz"
      status={
        <>
          {refused ? (
            <>
              <p className="font-semibold text-danger">
                Paused: ListenBrainz no longer accepts the token. Paste a new one to send the songs
                you play again.
              </p>
              {waiting > 0 && <p>{count(waiting, 'listen')} waiting.</p>}
            </>
          ) : (
            <>
              <p>
                On: the songs you play go to the ListenBrainz profile of{' '}
                <strong className="text-text">{account.userName}</strong>.
              </p>
              {waitingText !== '' && <p>{waitingText}</p>}
            </>
          )}
          {storageFailed && <StorageWarning noun="listen" />}
        </>
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

const LASTFM_CREDENTIALS_REFUSED =
  "Last.fm doesn't accept this API key and shared secret. Copy them again from your API account."

function LastfmRow() {
  const account = useScrobblingStore((state) => state.lastfm)
  const { status, waiting, storageFailed } = useQueue('lastfm', account !== undefined)
  const online = useOnline()
  const [apiKey, setApiKey] = useState('')
  const [secret, setSecret] = useState('')
  /** Whether a paused account shows the form for another key and secret. */
  const [editing, setEditing] = useState(false)
  const [authorization, setAuthorization] = useState<Authorization | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const finishing = useRef(false)

  /** Shows the form of a paused account, with its key filled in and the secret to enter. */
  const edit = (key: string) => {
    setApiKey(key)
    setSecret('')
    setEditing(true)
  }

  /**
   * Step 1: a request token for the user's API account, and the page that allows it. `stored`
   * says the credentials are the ones FXM kept: when Last.fm refuses them, the form asks for
   * new ones.
   */
  const start = async (credentials: LastfmCredentials, stored = false) => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const client = lastfmClientFor(credentials)
      const token = await client.getToken(scrobbleContext())
      setAuthorization({ credentials, token, url: client.authorizeUrl(token), opened: false })
    } catch (failure) {
      const refused = failure instanceof ScrobbleError && failure.failure === 'refused'
      if (refused && stored) edit(credentials.apiKey)
      setError(refused ? LASTFM_CREDENTIALS_REFUSED : failureText('lastfm', failure))
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
        // Scrobbles queued for another user, or left by an account disconnected before, are
        // not this one's to send. The same user, connecting again, keeps them.
        if (useScrobblingStore.getState().lastfm?.userName !== session.userName) {
          await forgetQueue('lastfm')
        }
        useScrobblingStore.getState().connectLastfm({ ...credentials, ...session })
        setAuthorization(null)
        setEditing(false)
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

  const disconnect = () => {
    setError('')
    setAuthorization(null)
    setEditing(false)
    useScrobblingStore.getState().disconnect('lastfm')
    void forgetQueue('lastfm')
  }

  const disconnectButton = account !== undefined && (
    <button type="button" onClick={disconnect} className={buttonClasses({ variant: 'secondary' })}>
      Disconnect
    </button>
  )

  /** The form for an API account's key and secret, with a Cancel button when `cancel` is given. */
  const credentialsForm = (cancel?: () => void) => (
    <form onSubmit={submit} autoComplete="off" className="space-y-3">
      <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
        <TextField
          {...NOT_A_LOGIN}
          label="API key"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <SecretField label="Shared secret" value={secret} onChange={setSecret} />
      </div>
      <p className="text-xs text-text-muted">
        Both stay on this device. The secret is never sent: it only signs FXM's requests to Last.fm.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={busy || apiKey.trim() === '' || secret.trim() === ''}
          className={buttonClasses()}
        >
          {busy ? 'Asking Last.fm…' : 'Connect'}
        </button>
        {cancel !== undefined && (
          <button type="button" onClick={cancel} className={buttonClasses({ variant: 'ghost' })}>
            Cancel
          </button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </form>
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
            Off. Connect to add the songs you play to your Last.fm profile, which is public. Last.fm
            asks every app for an API account of its own, so{' '}
            <NewTabLink href={LASTFM_API_ACCOUNT_URL}>create one</NewTabLink> (any name works, and
            FXM needs no callback URL), then enter its API key and shared secret here.
          </p>
        }
      >
        {credentialsForm()}
      </ServiceRow>
    )
  }

  const refused = account.refusedAt !== undefined
  const waitingText = pendingText(waiting, 'scrobble', status, online)
  return (
    <ServiceRow
      name="Last.fm"
      status={
        <>
          {refused ? (
            <>
              <p className="font-semibold text-danger">
                Paused: Last.fm no longer accepts FXM's session. Connect again to send the songs you
                play.
              </p>
              {waiting > 0 && <p>{count(waiting, 'scrobble')} waiting.</p>}
            </>
          ) : (
            <>
              <p>
                On: the songs you play go to the Last.fm profile of{' '}
                <strong className="text-text">{account.userName}</strong>, which is public.
              </p>
              {waitingText !== '' && <p>{waitingText}</p>}
            </>
          )}
          {storageFailed && <StorageWarning noun="scrobble" />}
        </>
      }
      action={disconnectButton}
    >
      {refused && editing ? (
        credentialsForm(() => {
          setEditing(false)
          setError('')
        })
      ) : (
        <>
          {refused && (
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void start({ apiKey: account.apiKey, secret: account.secret }, true)}
                className={buttonClasses()}
              >
                {busy ? 'Asking Last.fm…' : 'Connect again'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setError('')
                  edit(account.apiKey)
                }}
                className={buttonClasses({ variant: 'secondary' })}
              >
                Enter another key
              </button>
            </div>
          )}
          <ErrorText>{error}</ErrorText>
        </>
      )}
      <p className="text-xs text-text-muted">
        Disconnecting makes FXM forget the key, the secret and the session. To end the session at
        Last.fm too, remove the app in your{' '}
        <NewTabLink href={LASTFM_APPLICATIONS_URL}>Last.fm application settings</NewTabLink>.
      </p>
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
