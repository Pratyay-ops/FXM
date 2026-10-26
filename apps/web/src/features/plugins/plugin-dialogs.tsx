import type { PluginEntry, PluginOffer } from '@fxm/plugins'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { Dialog, DialogActions } from '../library/ui/dialog'
import { TextField } from '../library/ui/field'
import { operationsText, originText, pluginFailureText, shortChecksum } from './plugin-text'

/** What the user is told before they add or update any plugin. */
export const PLUGIN_WARNING =
  'Plugins are code from their authors, not from FXM. FXM runs a plugin apart from the app, where it can reach only the addresses above, and it learns what you ask of it, such as what you search for in its catalog. Add only plugins from people you trust.'

/** A host, in a list of hosts. */
function HostList({ hosts, added = [] }: { hosts: readonly string[]; added?: readonly string[] }) {
  return (
    <ul className="mt-1 space-y-1">
      {hosts.map((host) => (
        <li key={host} className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-elevated px-1.5 py-0.5 text-sm wrap-anywhere">{host}</code>
          {added.includes(host) && (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent">
              New
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * What an update changes about where a plugin comes from: another address than the one the
 * installed version came from, or another author. Someone else's plugin can take an installed
 * plugin's ID, so the user should see it before approving.
 */
export function provenanceNotices(offer: PluginOffer): string[] {
  const installed = offer.current
  if (installed === undefined) return []
  const notices: string[] = []
  const before = installed.origin
  const now = offer.package.origin
  if (before.kind === 'url' && (now.kind !== 'url' || now.url !== before.url)) {
    notices.push(
      `The installed version came from ${before.url}, not from here. Make sure this update comes from the same author.`,
    )
  }
  const unnamed = 'an unnamed author'
  const wasBy = installed.manifest.author ?? unnamed
  const isBy = offer.package.manifest.author ?? unnamed
  if (wasBy !== isBy) {
    notices.push(`The installed version is by ${wasBy}; this one is by ${isBy}.`)
  }
  return notices
}

/**
 * The approval of a plugin: what it is, the addresses it can contact, what it adds, where it came
 * from and its checksum, and the warning. Nothing is installed until the user says so; Cancel,
 * Escape and the close button decline.
 */
export function OfferDialog({
  offer,
  onClose,
  onInstall,
}: {
  offer: PluginOffer | undefined
  onClose: () => void
  onInstall: (offer: PluginOffer) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const hostsId = useId()
  // A new offer starts afresh.
  useEffect(() => {
    if (offer !== undefined) {
      setBusy(false)
      setFailure(undefined)
    }
  }, [offer])
  const manifest = offer?.package.manifest
  const installed = offer?.current
  const update = installed !== undefined
  const title =
    manifest === undefined
      ? ''
      : update
        ? `Update ${manifest.name} to ${manifest.version}?`
        : `Add ${manifest.name}?`
  const author = manifest?.author === undefined ? '' : ` · by ${manifest.author}`
  const notices = offer === undefined ? [] : provenanceNotices(offer)
  return (
    <Dialog
      open={offer !== undefined}
      onClose={onClose}
      title={title}
      {...(manifest === undefined
        ? {}
        : {
            description: update
              ? `Replaces version ${installed?.manifest.version}${author}`
              : `Version ${manifest.version}${author}`,
          })}
    >
      {offer !== undefined && manifest !== undefined && (
        <div className="space-y-4 text-sm">
          {manifest.description !== undefined && <p>{manifest.description}</p>}
          <div>
            <p id={hostsId} className="font-semibold">
              {manifest.hosts.length === 0
                ? 'It can contact no addresses: it can’t reach the network.'
                : 'It can contact only these addresses:'}
            </p>
            {manifest.hosts.length > 0 && (
              <HostList hosts={manifest.hosts} {...(update ? { added: offer.addedHosts } : {})} />
            )}
            {offer.removedHosts.length > 0 && (
              <p className="mt-2 text-text-muted">
                No longer contacts {offer.removedHosts.join(', ')}.
              </p>
            )}
          </div>
          {manifest.provides.length > 0 && (
            <p>
              <span className="font-semibold">It adds </span>
              {operationsText(manifest.provides)}.
              {update && offer.removedOperations.length > 0 && (
                <span className="text-text-muted">
                  {' '}
                  It no longer adds {operationsText(offer.removedOperations)}.
                </span>
              )}
            </p>
          )}
          <p className="text-text-muted">
            At most {manifest.requestsPerHour} requests an hour. Needs FXM {manifest.minFxmVersion}{' '}
            or later.
          </p>
          <p className="text-text-muted wrap-anywhere">
            {originText(offer.package.origin)}.{' '}
            <span className="whitespace-nowrap" title={manifest.sha256}>
              SHA-256 {shortChecksum(manifest.sha256)}
            </span>
            .
          </p>
          {notices.map((notice) => (
            <p key={notice} className="font-semibold text-danger">
              {notice}
            </p>
          ))}
          <p className="rounded-lg border border-border bg-elevated p-3">{PLUGIN_WARNING}</p>
          {failure !== undefined && (
            <p role="alert" className="font-semibold text-danger">
              {failure}
            </p>
          )}
          <DialogActions>
            <button
              type="button"
              data-autofocus=""
              className={buttonClasses({ variant: 'secondary' })}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              aria-describedby={hostsId}
              aria-disabled={busy}
              className={buttonClasses()}
              onClick={() => {
                if (busy) return
                setBusy(true)
                setFailure(undefined)
                onInstall(offer).then(
                  () => setBusy(false),
                  (error: unknown) => {
                    setBusy(false)
                    setFailure(pluginFailureText(error))
                  },
                )
              }}
            >
              {update ? 'Update' : 'Add plugin'}
            </button>
          </DialogActions>
        </div>
      )}
    </Dialog>
  )
}

/**
 * Asks for the address of a plugin and fetches it. Resolves the offer through `onOffer`; a
 * failure stays in the dialog. Closing it cancels the download.
 */
export function AddressDialog({
  open,
  onClose,
  fetchOffer,
  onOffer,
}: {
  open: boolean
  onClose: () => void
  fetchOffer: (address: string, signal: AbortSignal) => Promise<PluginOffer>
  onOffer: (offer: PluginOffer) => void
}) {
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const pending = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    if (open) return
    pending.current?.abort()
    pending.current = undefined
    setBusy(false)
    setFailure(undefined)
    setAddress('')
  }, [open])
  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setFailure(undefined)
    fetchOffer(address, controller.signal).then(
      (offer) => {
        if (controller.signal.aborted) return
        setBusy(false)
        onOffer(offer)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setBusy(false)
        setFailure(pluginFailureText(error))
      },
    )
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a plugin from an address"
      description="The address of its manifest (fxm-plugin.json) or of its plugin file, as its author gives it. FXM shows you the plugin before it adds anything."
    >
      <form onSubmit={submit} className="space-y-4">
        <TextField
          label="Address"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="https://example.org/fxm-plugin.json"
          value={address}
          onChange={(event) => setAddress(event.currentTarget.value)}
          hint="Only https:// addresses. FXM contacts only this address to fetch the plugin."
        />
        {failure !== undefined && (
          <p role="alert" className="text-sm font-semibold text-danger">
            {failure}
          </p>
        )}
        <DialogActions>
          <button type="button" className={buttonClasses({ variant: 'ghost' })} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" aria-disabled={busy} className={buttonClasses()}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

/** Confirms removing a plugin. */
export function RemoveDialog({
  entry,
  onClose,
  onRemove,
}: {
  entry: PluginEntry | undefined
  onClose: () => void
  onRemove: (entry: PluginEntry) => void
}) {
  return (
    <Dialog
      open={entry !== undefined}
      onClose={onClose}
      alert
      title={`Remove ${entry?.manifest.name ?? ''}?`}
      description="FXM deletes the plugin from this device. Songs of it in your library stay listed, but play again only once you add it again."
    >
      <DialogActions>
        <button
          type="button"
          data-autofocus=""
          className={buttonClasses({ variant: 'ghost' })}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className={buttonClasses({ variant: 'danger' })}
          onClick={() => {
            if (entry !== undefined) onRemove(entry)
            onClose()
          }}
        >
          Remove
        </button>
      </DialogActions>
    </Dialog>
  )
}
