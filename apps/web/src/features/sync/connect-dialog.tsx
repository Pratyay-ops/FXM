import { ExternalLink, KeyRound } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { addedLabel } from '../library/format'
import { Dialog, DialogActions } from '../library/ui/dialog'
import { TextField } from '../library/ui/field'
import {
  type ConnectAction,
  type ConnectPlan,
  confirmConnect,
  prepareConnect,
  replaceToken,
  runSync,
} from './controller'
import { NEW_TOKEN_URL } from './github'
import { setupErrorText, summaryText } from './messages'

/**
 * A fresh abort signal for each request a dialog makes; the last one is aborted when the
 * dialog closes (its content unmounts).
 */
function useAbortOnClose() {
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  return () => {
    controller.current?.abort()
    controller.current = new AbortController()
    return controller.current.signal
  }
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm font-semibold text-danger">
      {children}
    </p>
  )
}

function TokenLink() {
  return (
    <a
      href={NEW_TOKEN_URL}
      target="_blank"
      rel="noreferrer"
      className={buttonClasses({ variant: 'secondary' })}
    >
      <KeyRound aria-hidden="true" />
      Create it on GitHub
      <ExternalLink aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

const TOKEN_HELP =
  'GitHub opens its form filled in: a fine-grained token with only the Gists permission, which lets FXM read and change your gists and nothing else. Create it, then copy it.'

function Summary({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-3 text-sm">
      <p className="font-semibold">{title}</p>
      <p className="mt-0.5 text-text-muted">{children}</p>
    </div>
  )
}

/** What the confirmation shows for a plan, and the action it offers, if any. */
function confirmStep(plan: ConnectPlan): {
  action?: { kind: ConnectAction; label: string }
  body: ReactNode
} {
  const { gist, unreadable, login } = plan
  if (unreadable?.code === 'too-new') {
    return {
      body: (
        <p>
          Your sync gist was saved by a newer version of FXM, so this one can’t read it. Update FXM
          on this device, then set up sync again.
        </p>
      ),
    }
  }
  if (unreadable !== undefined) {
    return {
      action: { kind: 'rewrite', label: `Rewrite @${login}’s gist` },
      body: (
        <>
          <Summary title="Your sync gist">Changed outside FXM: it can’t be read.</Summary>
          <p>
            FXM can rewrite it with this device’s library. Your other devices keep their libraries
            and add back what this one lacks at their next sync.
          </p>
          <Summary title="On this device">{summaryText(plan.local)}</Summary>
        </>
      ),
    }
  }
  if (gist === undefined) {
    return {
      action: { kind: 'create', label: `Create a gist on @${login}` },
      body: (
        <>
          <p>
            There’s no sync gist on this account yet. FXM creates a secret one with this device’s
            library.
          </p>
          <Summary title="On this device">{summaryText(plan.local)}</Summary>
          <p className="text-text-muted">
            Already syncing on another device? Go back and paste the gist’s link from that device’s
            settings, or this device gets a separate gist of its own.
          </p>
        </>
      ),
    }
  }
  const saved = Date.parse(gist.savedAt)
  return {
    action: {
      kind: 'join',
      label: plan.localHasData ? `Merge with @${login}’s gist` : `Sync with @${login}’s gist`,
    },
    body: (
      <>
        <Summary title="Your sync gist">
          {summaryText(gist.summary)}
          {Number.isFinite(saved) && ` · saved ${addedLabel(saved)}`}
        </Summary>
        {plan.localHasData ? (
          <>
            <Summary title="On this device">{summaryText(plan.local)}</Summary>
            <p>
              FXM merges the two and removes nothing. Where both changed the same playlist, you keep
              both versions and choose later.
            </p>
          </>
        ) : (
          <p>Your synced library comes to this device.</p>
        )}
      </>
    ),
  }
}

function Confirm({
  plan,
  busy,
  error,
  onBack,
  onConfirm,
}: {
  plan: ConnectPlan
  busy: boolean
  error: string
  onBack: () => void
  onConfirm: (action: ConnectAction) => void
}) {
  const { login } = plan
  const { action, body } = confirmStep(plan)
  const account = `@${login}`
  return (
    <div className="space-y-4 text-sm">
      <p>
        Signed in to GitHub as <strong>{account}</strong>.
      </p>
      {body}
      {action !== undefined && (
        // On whose account: a token of someone else's account would hand them this library, and
        // let them change it from then on.
        <p>
          FXM copies this device’s library, listening history and settings to the gist of{' '}
          <strong>{account}</strong>, and keeps them in step with it from then on. Continue only if{' '}
          {account} is your own GitHub account.
        </p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <button type="button" className={buttonClasses({ variant: 'secondary' })} onClick={onBack}>
          Back
        </button>
        {action !== undefined && (
          <button
            type="button"
            className={buttonClasses()}
            disabled={busy}
            onClick={() => onConfirm(action.kind)}
          >
            {busy ? 'Syncing…' : action.label}
          </button>
        )}
      </DialogActions>
    </div>
  )
}

function ConnectPanel({ onDone, initialToken }: { onDone: () => void; initialToken?: string }) {
  const [token, setToken] = useState(initialToken ?? '')
  const [gistLink, setGistLink] = useState('')
  const [plan, setPlan] = useState<ConnectPlan | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const newSignal = useAbortOnClose()

  const check = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      setPlan(await prepareConnect({ token, gistLink }, newSignal()))
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') return
      setError(setupErrorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (action: ConnectAction) => {
    if (plan === null) return
    setError('')
    setBusy(true)
    try {
      await confirmConnect(plan, { signal: newSignal(), action })
      onDone()
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') return
      setError(setupErrorText(failure))
      setBusy(false)
    }
  }

  if (plan !== null) {
    return (
      <Confirm
        plan={plan}
        busy={busy}
        error={error}
        onBack={() => {
          setPlan(null)
          setError('')
        }}
        onConfirm={confirm}
      />
    )
  }
  return (
    <form className="space-y-5" onSubmit={check}>
      <div className="space-y-2">
        <h3 className="font-bold">1. Create a token</h3>
        <p className="text-sm text-text-muted">{TOKEN_HELP}</p>
        <TokenLink />
      </div>
      <TextField
        label="2. Paste the token"
        hint="FXM keeps it on this device and sends it only to GitHub."
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(event) => setToken(event.currentTarget.value)}
        data-autofocus
      />
      <details className="rounded-xl border border-border p-3 text-sm [&_summary]:cursor-pointer">
        <summary className="font-semibold">Already syncing on another device?</summary>
        <p className="mt-2 text-text-muted">
          FXM finds your sync gist by itself. If it doesn’t, paste the gist’s link from Settings ›
          Sync on that device.
        </p>
        <TextField
          className="mt-3"
          label="Gist link (optional)"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={gistLink}
          onChange={(event) => setGistLink(event.currentTarget.value)}
        />
      </details>
      <p className="text-xs text-text-muted">
        Your playlists, likes, follows, listening history and settings go to a secret gist on your
        GitHub account. GitHub doesn’t list or search secret gists, but anyone with the link can
        open one, and every earlier version of it, which GitHub keeps. Removing something in FXM
        doesn’t remove it from those versions: delete the gist to remove everything.
      </p>
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <button type="button" className={buttonClasses({ variant: 'secondary' })} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={buttonClasses()} disabled={busy || token.trim() === ''}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </DialogActions>
    </form>
  )
}

/**
 * Sets sync up: a token the user creates on GitHub, then the account's sync gist (found, pasted
 * or created), confirmed before anything changes.
 */
export function ConnectDialog({
  open,
  onClose,
  initialToken,
}: {
  open: boolean
  onClose: () => void
  /** A token to start from, e.g. when setting up again after the gist was deleted. */
  initialToken?: string | undefined
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Sync with GitHub"
      description="Keep your library and settings the same on all your devices, through a secret gist on your own GitHub account."
    >
      <ConnectPanel onDone={onClose} {...(initialToken === undefined ? {} : { initialToken })} />
    </Dialog>
  )
}

function TokenPanel({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const newSignal = useAbortOnClose()

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await replaceToken(token, newSignal())
      onDone()
      void runSync('manual')
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') return
      setError(setupErrorText(failure))
      setBusy(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={save}>
      <div className="space-y-2">
        <p className="text-sm text-text-muted">{TOKEN_HELP}</p>
        <TokenLink />
      </div>
      <TextField
        label="New token"
        hint="FXM keeps it on this device and sends it only to GitHub."
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(event) => setToken(event.currentTarget.value)}
        data-autofocus
      />
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <button type="button" className={buttonClasses({ variant: 'secondary' })} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={buttonClasses()} disabled={busy || token.trim() === ''}>
          {busy ? 'Checking…' : 'Save and sync'}
        </button>
      </DialogActions>
    </form>
  )
}

/** Replaces the token, e.g. after it expired. */
export function TokenDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Paste a new token"
      description="Use a token of the same GitHub account. Sync picks up where it left off."
    >
      <TokenPanel onDone={onClose} />
    </Dialog>
  )
}
