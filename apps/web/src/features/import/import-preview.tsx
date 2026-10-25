import { CATALOG_MODE_LABELS } from '@fxm/core'
import { useId, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { countLabel } from '../library/format'
import { failureText } from '../library/playlist-dialogs'
import { showStatus } from '../library/status'
import { TextField } from '../library/ui/field'
import { useSettingsStore } from '../settings/settings-store'
import { skippedText } from './format'
import type { PickedImport } from './import-page'
import { startImports } from './runner'
import type { ImportServicesAccess } from './services'

/** What the confirmation says once an import started. */
function startedText(playlists: number, plays: number, followed: number): string {
  const parts: string[] = []
  if (playlists > 0) parts.push(countLabel(playlists, 'playlist'))
  if (plays > 0) parts.push(countLabel(plays, 'play'))
  if (followed > 0) parts.push(countLabel(followed, 'album or artist', 'albums and artists'))
  return parts.length === 0 ? 'Nothing new to import' : `Importing ${parts.join(', ')}`
}

/**
 * What an input holds, with what to import: each playlist (renamed, or left out), the
 * listening history and the saved albums and artists. Starting creates the playlists at once;
 * finding the songs goes on in the background.
 */
export function ImportPreview({
  picked,
  services,
  onClose,
}: {
  picked: PickedImport
  services: ImportServicesAccess
  onClose: () => void
}) {
  const { parsed } = picked
  const mode = useSettingsStore((state) => state.catalogMode)
  const [chosen, setChosen] = useState(() => new Set(parsed.collections.map((_, index) => index)))
  const [names, setNames] = useState<Record<number, string>>({})
  const [history, setHistory] = useState(true)
  const [follows, setFollows] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleId = useId()
  const skipped = skippedText(parsed.skipped)
  const nothing =
    chosen.size === 0 &&
    (parsed.plays.length === 0 || !history) &&
    (parsed.follows.length === 0 || !follows)

  const toggle = (index: number) =>
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const started = await startImports(
        parsed,
        { collections: [...chosen].sort((a, b) => a - b), names, history, follows },
        mode,
        await services.get(),
      )
      showStatus(
        startedText(
          started.importIds.length,
          started.historyId === undefined ? 0 : parsed.plays.length,
          started.followed,
        ),
      )
      onClose()
    } catch (failure) {
      setError(failureText(failure))
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby={titleId} className="space-y-5 rounded-2xl border border-border p-4">
      <div>
        <h2 id={titleId} className="text-xl font-bold tracking-tight">
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
            onChange={(event) => {
              const value = event.currentTarget.value
              setNames((current) => ({ ...current, 0: value }))
            }}
            className="max-w-xl"
          />
          <p className="text-sm text-text-muted">
            {countLabel(parsed.collections[0].rows.length, 'song')}
          </p>
        </div>
      ) : (
        parsed.collections.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="mb-2 font-semibold">
              Playlists ({parsed.collections.length.toLocaleString('en')})
            </legend>
            <ul className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {parsed.collections.map((collection, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the list never changes while shown, and names repeat
                <li key={index}>
                  <label className="flex min-h-touch cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-text/5">
                    <input
                      type="checkbox"
                      checked={chosen.has(index)}
                      onChange={() => toggle(index)}
                      className="size-4 shrink-0 accent-accent"
                    />
                    <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                    <span className="shrink-0 text-sm text-text-muted">
                      {countLabel(collection.rows.length, 'song')}
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
          <span className="text-sm">
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
          <span className="text-sm">
            <span className="block font-semibold">
              Saved albums and followed artists: {parsed.follows.length.toLocaleString('en')}
            </span>
            <span className="block text-text-muted">They join your library.</span>
          </span>
        </label>
      )}

      {skipped && <p className="text-sm text-text-muted">Left out: {skipped}.</p>}

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
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={buttonClasses()}
          disabled={busy || nothing}
          onClick={start}
        >
          Start import
        </button>
        <button type="button" className={buttonClasses({ variant: 'ghost' })} onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  )
}
