import { CATALOG_MODE_LABELS } from '@fxm/core'
import { useEffect, useId, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { countLabel } from '../library/format'
import { failureText } from '../library/playlist-dialogs'
import { showStatus } from '../library/status'
import { TextField } from '../library/ui/field'
import { useSettingsStore } from '../settings/settings-store'
import { skippedText } from './format'
import type { PickedImport } from './import-page'
import { MatchingNotice } from './matching-notice'
import { type StartedImports, StartImportsError, startImports } from './runner'
import type { ImportServicesAccess, MatchingAvailability } from './services'

/** What the confirmation says once an import started. */
function startedText(started: StartedImports, plays: number): string {
  const parts: string[] = []
  const playlists = started.importIds.length
  if (playlists > 0) parts.push(countLabel(playlists, 'playlist'))
  if (started.historyId !== undefined) parts.push(countLabel(plays, 'play'))
  if (started.followed > 0) {
    parts.push(countLabel(started.followed, 'album or artist', 'albums and artists'))
  }
  const text = parts.length === 0 ? 'Nothing new to import' : `Importing ${parts.join(', ')}`
  const failed = [
    started.failed.includes('follows') ? 'the saved albums and artists' : '',
    started.failed.includes('history') ? 'the listening history' : '',
  ].filter(Boolean)
  if (failed.length === 0) return text
  return `${text}. ${failed.join(' and ')} couldn’t be saved: import the download again to add ${failed.length > 1 ? 'them' : 'it'}.`
}

/** The "All playlists" checkbox: checked, unchecked, or mixed while only some are chosen. */
function AllCheckbox({
  checked,
  mixed,
  onChange,
  label,
}: {
  checked: boolean
  mixed: boolean
  onChange: () => void
  label: string
}) {
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (box.current) box.current.indeterminate = mixed
  }, [mixed])
  return (
    <label className="flex min-h-touch cursor-pointer items-center gap-3 rounded-md px-2 font-semibold hover:bg-text/5">
      <input
        ref={box}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="size-4 shrink-0 accent-accent"
      />
      {label}
    </label>
  )
}

/**
 * What an input holds, with what to import: each playlist (renamed, or left out), the
 * listening history and the saved albums and artists. Starting creates the playlists at once;
 * finding the songs goes on in the background.
 */
export function ImportPreview({
  picked,
  services,
  matching,
  onClose,
}: {
  picked: PickedImport
  services: ImportServicesAccess
  matching: MatchingAvailability | undefined
  /** Closes the preview; `started` is the first import started, when one was. */
  onClose: (started?: string) => void
}) {
  const { parsed } = picked
  const mode = useSettingsStore((state) => state.catalogMode)
  const [chosen, setChosen] = useState(() => new Set(parsed.collections.map((_, index) => index)))
  // Playlists already importing after a start that stopped half-way: never created twice.
  const [created, setCreated] = useState<ReadonlySet<number>>(() => new Set())
  const [names, setNames] = useState<Record<number, string>>({})
  const [history, setHistory] = useState(true)
  const [follows, setFollows] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const skipped = skippedText(parsed.skipped)
  const open = parsed.collections.map((_, index) => index).filter((index) => !created.has(index))
  const picking = open.filter((index) => chosen.has(index))
  const songs = picking.reduce(
    (total, index) => total + (parsed.collections[index]?.rows.length ?? 0),
    0,
  )
  const nothing =
    picking.length === 0 &&
    (parsed.plays.length === 0 || !history) &&
    (parsed.follows.length === 0 || !follows)

  // The preview replaces what the user chose from: focus moves to its heading.
  useEffect(() => {
    heading.current?.focus()
  }, [])

  const toggle = (index: number) =>
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })

  const toggleAll = () => setChosen(picking.length === open.length ? new Set() : new Set(open))

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const started = await startImports(
        parsed,
        { collections: picking, names, history, follows },
        mode,
        await services.get(),
      )
      showStatus(startedText(started, parsed.plays.length))
      onClose(started.importIds[0] ?? started.historyId)
    } catch (failure) {
      if (failure instanceof StartImportsError) {
        setCreated((current) => new Set([...current, ...failure.created]))
        setError(
          `${failureText(failure.reason)} ${
            failure.created.length > 0
              ? `${countLabel(failure.created.length, 'playlist')} started; Start again imports the rest.`
              : ''
          }`.trim(),
        )
      } else setError(failureText(failure))
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby={titleId} className="space-y-5 rounded-2xl border border-border p-4">
      <div>
        <h2
          ref={heading}
          id={titleId}
          tabIndex={-1}
          className="text-xl font-bold tracking-tight outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Ready to import
        </h2>
        <p className="mt-1 text-sm break-all text-text-muted">{parsed.label}</p>
      </div>

      {parsed.collections.length === 1 && parsed.collections[0] !== undefined ? (
        <div className="space-y-2">
          <TextField
            label="Playlist name"
            value={names[0] ?? parsed.collections[0].name}
            maxLength={100}
            disabled={created.has(0)}
            onChange={(event) => {
              const value = event.currentTarget.value
              setNames((current) => ({ ...current, 0: value }))
            }}
            className="max-w-xl"
          />
          <p className="text-sm text-text-muted">
            {countLabel(parsed.collections[0].rows.length, 'song')}
            {created.has(0) && ' · importing'}
          </p>
        </div>
      ) : (
        parsed.collections.length > 1 && (
          <fieldset className="min-w-0 space-y-2">
            <legend className="mb-2 w-full">
              <AllCheckbox
                label={`All playlists (${parsed.collections.length.toLocaleString('en')})`}
                checked={open.length > 0 && picking.length === open.length}
                mixed={picking.length > 0 && picking.length < open.length}
                onChange={toggleAll}
              />
            </legend>
            <ul className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {parsed.collections.map((collection, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the list never changes while shown, and names repeat
                <li key={index}>
                  <label className="flex min-h-touch cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-text/5 has-[:disabled]:cursor-default">
                    <input
                      type="checkbox"
                      checked={created.has(index) || chosen.has(index)}
                      disabled={created.has(index)}
                      onChange={() => toggle(index)}
                      className="size-4 shrink-0 accent-accent"
                    />
                    <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                    <span className="shrink-0 text-sm text-text-muted">
                      {created.has(index)
                        ? 'Importing'
                        : countLabel(collection.rows.length, 'song')}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )
      )}

      {parsed.plays.length > 0 && (
        <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent">
          <input
            type="checkbox"
            checked={history}
            onChange={() => setHistory((value) => !value)}
            className="mt-0.5 size-4 shrink-0 accent-accent"
          />
          <span className="min-w-0 text-sm">
            <span className="block font-semibold">
              Listening history: {countLabel(parsed.plays.length, 'play')}
            </span>
            <span className="block text-text-muted">
              Your recommendations learn from it. It goes into Recently played; nothing is searched
              or played.
            </span>
          </span>
        </label>
      )}

      {parsed.follows.length > 0 && (
        <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent">
          <input
            type="checkbox"
            checked={follows}
            onChange={() => setFollows((value) => !value)}
            className="mt-0.5 size-4 shrink-0 accent-accent"
          />
          <span className="min-w-0 text-sm">
            <span className="block font-semibold">
              Saved albums and followed artists: {parsed.follows.length.toLocaleString('en')}
            </span>
            <span className="block text-text-muted">They join your library.</span>
          </span>
        </label>
      )}

      {skipped && <p className="text-sm text-text-muted">Left out: {skipped}.</p>}

      {picking.length > 0 && <MatchingNotice matching={matching} where="preview" />}

      <p className="max-w-prose text-sm text-text-muted">
        FXM finds each song for the {CATALOG_MODE_LABELS[mode]} mode, slowly and in the background,
        so your own listening stays within YouTube’s request limits. Songs it isn’t sure about wait
        for you to review them. If you leave, resume the import here later: nothing it already found
        is lost.
      </p>

      {error && (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={buttonClasses()}
          disabled={busy || nothing}
          onClick={start}
        >
          Start import
        </button>
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost' })}
          onClick={() => onClose()}
        >
          Cancel
        </button>
        {parsed.collections.length > 1 && (
          <p className="text-sm text-text-muted" aria-live="polite">
            {picking.length === 0
              ? 'No playlist chosen'
              : `${countLabel(songs, 'song')} in ${countLabel(picking.length, 'playlist')}`}
          </p>
        )}
      </div>
    </section>
  )
}
