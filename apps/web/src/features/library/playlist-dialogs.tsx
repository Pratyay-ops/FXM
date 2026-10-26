import type { EntityId, Track } from '@fxm/core'
import { ListMusic, Plus } from 'lucide-react'
import { type FormEvent, type ReactNode, useCallback, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { usePlaylistList } from '../../db/hooks'
import { getLibrary } from '../../db/repo'
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from '../../db/types'
import { CoverArt } from './cover-art'
import { failureText } from './failure'
import { artworkUrl, countLabel } from './format'
import { showStatus } from './status'
import { Dialog, DialogActions } from './ui/dialog'
import { TextAreaField, TextField } from './ui/field'

/** What the dialogs need to know about a playlist. */
export interface PlaylistRef {
  id: EntityId<'playlist'>
  name: string
  description?: string | undefined
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-danger">
      {children}
    </p>
  )
}

/** The name the next new playlist suggests: "My playlist #3". */
function useSuggestedName(): string {
  const list = usePlaylistList()
  if (list.status !== 'ready') return 'My playlist'
  const own = list.data.items.filter((item) => item.origin === 'local' && !item.system).length
  return `My playlist #${own + 1}`
}

function CreateForm({
  tracks,
  onDone,
  onCancel,
}: {
  tracks?: readonly Track[] | undefined
  onDone: (id: EntityId<'playlist'>, name: string) => void
  onCancel: () => void
}) {
  const suggested = useSuggestedName()
  // Follows the suggestion (which may still be loading) until the user types.
  const [typed, setTyped] = useState<string | null>(null)
  const name = typed ?? suggested
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() === '') {
      setError('Give the playlist a name.')
      return
    }
    setBusy(true)
    try {
      const id = await getLibrary().createPlaylist({
        name,
        description,
        ...(tracks === undefined ? {} : { tracks }),
      })
      onDone(id, name.trim())
    } catch (failure) {
      setError(failureText(failure))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <TextField
        label="Name"
        value={name}
        maxLength={MAX_NAME_LENGTH}
        required
        data-autofocus=""
        onChange={(event) => setTyped(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
      />
      <TextAreaField
        label="Description (optional)"
        value={description}
        maxLength={MAX_DESCRIPTION_LENGTH}
        onChange={(event) => setDescription(event.currentTarget.value)}
      />
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <button type="button" className={buttonClasses({ variant: 'ghost' })} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={buttonClasses()} disabled={busy}>
          Create
        </button>
      </DialogActions>
    </form>
  )
}

/** "New playlist". Calls `onCreated` with the new playlist's ID. */
export function CreatePlaylistDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated?: ((id: EntityId<'playlist'>) => void) | undefined
}) {
  return (
    <Dialog open={open} onClose={onClose} title="New playlist">
      <CreateForm
        onCancel={onClose}
        onDone={(id, name) => {
          showStatus(`Created ${name}`)
          onClose()
          onCreated?.(id)
        }}
      />
    </Dialog>
  )
}

function RenameForm({ playlist, onClose }: { playlist: PlaylistRef; onClose: () => void }) {
  const [name, setName] = useState(playlist.name)
  const [description, setDescription] = useState(playlist.description ?? '')
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() === '') {
      setError('Give the playlist a name.')
      return
    }
    try {
      await getLibrary().updatePlaylist(playlist.id, { name, description })
      showStatus('Saved')
      onClose()
    } catch (failure) {
      setError(failureText(failure))
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <TextField
        label="Name"
        value={name}
        maxLength={MAX_NAME_LENGTH}
        required
        data-autofocus=""
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <TextAreaField
        label="Description (optional)"
        value={description}
        maxLength={MAX_DESCRIPTION_LENGTH}
        onChange={(event) => setDescription(event.currentTarget.value)}
      />
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <button type="button" className={buttonClasses({ variant: 'ghost' })} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className={buttonClasses()}>
          Save
        </button>
      </DialogActions>
    </form>
  )
}

/** "Edit details": a playlist's name and description. */
export function RenamePlaylistDialog({
  playlist,
  onClose,
}: {
  playlist: PlaylistRef | null
  onClose: () => void
}) {
  return (
    <Dialog open={playlist !== null} onClose={onClose} title="Edit details">
      {playlist && <RenameForm playlist={playlist} onClose={onClose} />}
    </Dialog>
  )
}

/**
 * "Delete playlist?" Calls `onDeleted` once it is gone, and then gives focus to `focusAfter`:
 * the button that opened the dialog, in the deleted playlist's row, is gone too. Focus starts
 * on Cancel, so an extra Enter deletes nothing.
 */
export function DeletePlaylistDialog({
  playlist,
  onClose,
  onDeleted,
  focusAfter,
}: {
  playlist: PlaylistRef | null
  onClose: () => void
  onDeleted?: ((id: EntityId<'playlist'>) => void) | undefined
  focusAfter?: (() => HTMLElement | null) | undefined
}) {
  const [error, setError] = useState('')
  // Kept from the delete until the dialog has closed, when the props are already gone.
  const afterDelete = useRef<(() => HTMLElement | null) | undefined>(undefined)
  const close = () => {
    setError('')
    onClose()
  }
  return (
    <Dialog
      open={playlist !== null}
      onClose={close}
      alert
      finalFocus={() => {
        const target = afterDelete.current
        afterDelete.current = undefined
        return target?.()
      }}
      title="Delete playlist?"
      description={
        playlist && (
          <p>
            “{playlist.name}” will be removed from your library on this device. Its songs stay in
            Liked songs and your other playlists.
          </p>
        )
      }
    >
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <button
          type="button"
          data-autofocus=""
          className={buttonClasses({ variant: 'ghost' })}
          onClick={close}
        >
          Cancel
        </button>
        <button
          type="button"
          className={buttonClasses({ variant: 'danger' })}
          onClick={async () => {
            if (!playlist) return
            try {
              await getLibrary().deletePlaylist(playlist.id)
              showStatus(`Deleted ${playlist.name}`)
              afterDelete.current = focusAfter
              close()
              onDeleted?.(playlist.id)
            } catch (failure) {
              setError(failureText(failure))
            }
          }}
        >
          Delete
        </button>
      </DialogActions>
    </Dialog>
  )
}

function PlaylistChoices({ tracks, onClose }: { tracks: readonly Track[]; onClose: () => void }) {
  const list = usePlaylistList()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  if (creating) {
    return (
      <CreateForm
        tracks={tracks}
        onCancel={() => setCreating(false)}
        onDone={(_, name) => {
          showStatus(`Added to ${name}`)
          onClose()
        }}
      />
    )
  }

  const own =
    list.status === 'ready'
      ? list.data.items.filter((item) => item.origin === 'local' && !item.system)
      : []

  return (
    <div>
      <button
        type="button"
        className={buttonClasses({ variant: 'secondary', className: 'w-full justify-start' })}
        onClick={() => setCreating(true)}
      >
        <Plus aria-hidden="true" />
        New playlist
      </button>
      {own.length > 0 && (
        <ul aria-label="Your playlists" className="mt-3 max-h-80 space-y-1 overflow-y-auto p-0.5">
          {own.map((playlist) => (
            <li key={playlist.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-elevated"
                onClick={async () => {
                  try {
                    const { added } = await getLibrary().addTracks(playlist.id, tracks)
                    showStatus(
                      added === 0
                        ? `Already in ${playlist.name}`
                        : `Added ${tracks.length === 1 ? '' : `${countLabel(added, 'song')} `}to ${playlist.name}`,
                    )
                    onClose()
                  } catch (failure) {
                    setError(failureText(failure))
                  }
                }}
              >
                <CoverArt
                  src={artworkUrl(playlist.artwork, 80)}
                  seed={`playlist:${playlist.id}`}
                  icon={ListMusic}
                  rounded="sm"
                  className="size-10"
                />
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{playlist.name}</span>
                  <span className="block truncate text-xs text-text-muted">
                    {countLabel(playlist.trackCount ?? 0, 'song')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  )
}

/** "Add to playlist": pick one of the user's playlists, or make a new one with the tracks. */
export function AddToPlaylistDialog({
  tracks,
  onClose,
}: {
  tracks: readonly Track[] | null
  onClose: () => void
}) {
  const title =
    tracks?.length === 1 ? 'Add to playlist' : `Add ${countLabel(tracks?.length ?? 0, 'song')}`
  return (
    <Dialog open={tracks !== null} onClose={onClose} title={title}>
      {tracks && <PlaylistChoices tracks={tracks} onClose={onClose} />}
    </Dialog>
  )
}

type DialogState =
  | { type: 'create' }
  | { type: 'rename'; playlist: PlaylistRef }
  | { type: 'delete'; playlist: PlaylistRef; focusAfter?: (() => HTMLElement | null) | undefined }
  | null

/**
 * The create, edit and delete dialogs, for a component that offers those actions. Render
 * `dialogs` once. `remove` takes what should get focus once the playlist is deleted.
 */
export function usePlaylistDialogs({
  onCreated,
  onDeleted,
}: {
  onCreated?: (id: EntityId<'playlist'>) => void
  onDeleted?: (id: EntityId<'playlist'>) => void
} = {}) {
  const [state, setState] = useState<DialogState>(null)
  const close = useCallback(() => setState(null), [])
  return {
    create: useCallback(() => setState({ type: 'create' }), []),
    rename: useCallback((playlist: PlaylistRef) => setState({ type: 'rename', playlist }), []),
    remove: useCallback(
      (playlist: PlaylistRef, focusAfter?: () => HTMLElement | null) =>
        setState({ type: 'delete', playlist, focusAfter }),
      [],
    ),
    dialogs: (
      <>
        <CreatePlaylistDialog
          open={state?.type === 'create'}
          onClose={close}
          onCreated={onCreated}
        />
        <RenamePlaylistDialog
          playlist={state?.type === 'rename' ? state.playlist : null}
          onClose={close}
        />
        <DeletePlaylistDialog
          playlist={state?.type === 'delete' ? state.playlist : null}
          focusAfter={state?.type === 'delete' ? state.focusAfter : undefined}
          onClose={close}
          onDeleted={onDeleted}
        />
      </>
    ),
  }
}

/** Copies a playlist and confirms it. */
export async function duplicatePlaylist(playlist: PlaylistRef): Promise<void> {
  try {
    await getLibrary().duplicatePlaylist(playlist.id)
    showStatus(`Created ${playlist.name} (copy)`)
  } catch (failure) {
    showStatus(failureText(failure))
  }
}
