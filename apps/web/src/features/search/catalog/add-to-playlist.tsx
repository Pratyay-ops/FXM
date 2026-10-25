import type { Track } from '@fxm/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ListMusic, Plus, X } from 'lucide-react'
import { type FormEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Artwork } from '../../../components/ui/artwork'
import { buttonClasses } from '../../../components/ui/button'
import { IconButton } from '../../../components/ui/icon-button'
import { Skeleton } from '../../../components/ui/skeleton'
import { type LibraryActions, type LibraryPlaylist, useMediaActions } from '../actions'
import { showFeedback } from '../feedback'
import { countLabel } from './format'

/** What the dialog adds: the tracks, and what to call them, e.g. an album's name. */
export interface AddToPlaylistRequest {
  readonly tracks: readonly Track[]
  readonly title: string
}

interface AddToPlaylistState {
  request: AddToPlaylistRequest | null
  open: (request: AddToPlaylistRequest) => void
  close: () => void
}

/** Which tracks the add-to-playlist dialog is open for, if any. */
export const useAddToPlaylistStore = create<AddToPlaylistState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}))

/** Opens the add-to-playlist dialog for `tracks`. */
export function openAddToPlaylist(request: AddToPlaylistRequest): void {
  useAddToPlaylistStore.getState().open(request)
}

const PLAYLISTS_QUERY_KEY = ['library', 'playlists'] as const

/**
 * The add-to-playlist dialog: the user's playlists from the library (stage 2.6), and a field
 * for a new one. Render it once per page; `openAddToPlaylist` opens it.
 */
export function AddToPlaylistDialog() {
  const request = useAddToPlaylistStore((state) => state.request)
  const close = useAddToPlaylistStore((state) => state.close)
  const { library } = useMediaActions()
  if (!request || !library) return null
  return <PlaylistPicker request={request} library={library} onClose={close} />
}

function PlaylistPicker({
  request,
  library,
  onClose,
}: {
  request: AddToPlaylistRequest
  library: LibraryActions
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const nameId = useId()
  const queryClient = useQueryClient()
  const playlists = useQuery({ queryKey: PLAYLISTS_QUERY_KEY, queryFn: () => library.playlists() })
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const count = countLabel(request.tracks.length, 'song')

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    if (!element.open) element.showModal()
    // Start on the dialog itself: its playlists may still be loading.
    element.focus()
  }, [])

  const finish = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: PLAYLISTS_QUERY_KEY })
    showFeedback(message)
    dialog.current?.close()
  }

  const addTo = async (playlist: LibraryPlaylist) => {
    setBusy(true)
    setFailure(undefined)
    try {
      await library.addToPlaylist(playlist.id, request.tracks)
      finish(`Added ${count} to ${playlist.name}`)
    } catch {
      setFailure(`Couldn't add to ${playlist.name}. Try again.`)
      setBusy(false)
    }
  }

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setFailure(undefined)
    try {
      const playlist = await library.createPlaylist(trimmed, request.tracks)
      finish(`Created ${playlist.name} with ${count}`)
    } catch {
      setFailure(`Couldn't create ${trimmed}. Try again.`)
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      tabIndex={-1}
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself (its content fills it): close.
      // Keyboard users have Escape and the Close button.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close()
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-0 text-text shadow-xl outline-none backdrop:bg-black/60"
    >
      <div className="flex max-h-[min(36rem,85dvh)] flex-col">
        <div className="flex items-start gap-3 border-b border-border p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-bold tracking-tight">
              Add to playlist
            </h2>
            <p className="mt-0.5 truncate text-sm text-text-muted">
              {count} from {request.title}
            </p>
          </div>
          <IconButton
            label="Close"
            icon={<X />}
            className="-mt-1 -mr-1"
            onClick={() => dialog.current?.close()}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-3">
          {playlists.isPending ? (
            <div role="status" className="space-y-2 p-2">
              <span className="sr-only">Loading your playlists…</span>
              <Skeleton className="h-12 w-full rounded-md" />
              <Skeleton className="h-12 w-full rounded-md" />
            </div>
          ) : playlists.isError ? (
            <p className="p-2 text-sm text-text-muted">Your playlists couldn't be loaded.</p>
          ) : playlists.data.length === 0 ? (
            <p className="p-2 text-sm text-text-muted">You have no playlists yet.</p>
          ) : (
            <ul aria-label="Your playlists" className="space-y-0.5">
              {playlists.data.map((playlist) => (
                <li key={playlist.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void addTo(playlist)}
                    className="flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors hover:bg-text/6 disabled:opacity-50"
                  >
                    <Artwork
                      seed={`playlist:${playlist.id}`}
                      icon={ListMusic}
                      rounded="sm"
                      className="size-10"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{playlist.name}</span>
                      {playlist.trackCount !== undefined && (
                        <span className="block text-xs text-text-muted">
                          {countLabel(playlist.trackCount, 'song')}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form
          onSubmit={(event) => void create(event)}
          className="border-t border-border p-4 sm:p-5"
        >
          <label htmlFor={nameId} className="text-sm font-semibold">
            New playlist
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Playlist name"
              autoComplete="off"
              maxLength={100}
              className="h-touch min-w-0 flex-1 rounded-full border border-border-strong/60 bg-elevated px-4 text-base text-text placeholder:text-text-muted hover:border-border-strong focus:border-border-strong"
            />
            <button
              type="submit"
              disabled={busy || name.trim() === ''}
              className={buttonClasses({ className: 'px-4' })}
            >
              <Plus aria-hidden="true" />
              Create
            </button>
          </div>
          {failure && (
            <p role="alert" className="mt-3 text-sm font-medium text-danger">
              {failure}
            </p>
          )}
        </form>
      </div>
    </dialog>
  )
}
