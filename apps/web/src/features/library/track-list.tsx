import type { EntityId, Track } from '@fxm/core'
import {
  ArrowDownToLine,
  CircleMinus,
  Clock3,
  Ellipsis,
  GripVertical,
  Heart,
  ListMinus,
  ListPlus,
  Music,
} from 'lucide-react'
import { memo, type ReactNode, useCallback, useId, useMemo, useRef, useState } from 'react'
import { IconButton, iconButtonClasses } from '../../components/ui/icon-button'
import { useLibrary } from '../../db/hooks'
import type { MoveTarget } from '../../db/ordering'
import { moveKeys } from '../../db/ordering'
import type { TrackRow } from '../../db/repo'
import type { OrderUndo } from '../../db/types'
import { cn } from '../../lib/cn'
import { downloadTracks, removeDownloads } from '../downloads/actions'
import { useCanDownload } from '../downloads/hooks'
import { useDownloadMenuItem } from '../downloads/menu'
import { CoverArt } from './cover-art'
import { failureText } from './failure'
import { addedLabel, artistNames, artworkUrl, countLabel, trackDuration } from './format'
import {
  moveMenuItems,
  moveMessage,
  OrderNotice,
  OrderToolbar,
  SelectionAction,
  SelectionBar,
  useOptimisticOrder,
} from './order-controls'
import { AddToPlaylistDialog } from './playlist-dialogs'
import { sortTrackRows, TRACK_SORTS } from './sort'
import { SortableList, useDragState, useSortableItem } from './sortable'
import { showStatus } from './status'
import { type MenuItem, MenuPopup, returnFocusTo } from './ui/menu'
import { neighborAfterRemoval, rowControl, useFocusAfterRemoval } from './use-focus-after-removal'
import { useSelection } from './use-selection'
import { CUSTOM_VIEW, useLibraryViewStore, useTrackView } from './view-store'

/** What a track list is: the user's playlist, Liked songs or Downloads. */
export type TrackListKind = 'playlist' | 'liked' | 'downloads'

export interface TrackListProps {
  listId: EntityId<'playlist'>
  /** The rows in the saved custom order. */
  rows: readonly TrackRow[]
  /** The order before the last shuffle or saved sort, if Undo is still possible. */
  undo: OrderUndo | undefined
  kind: TrackListKind
  /** The list's name, for labels: "Road trip". */
  name: string
  /** Shown instead of the list when it is empty. */
  empty: ReactNode
}

const UNKNOWN_TITLE = 'Unavailable song'

/** The controls of a row that can take focus after a removal, by `data-*` attribute. */
const CONTROLS = {
  menu: '[data-row-menu]',
  select: 'input[type="checkbox"]',
  like: '[data-row-like]',
} as const

interface RowBodyProps {
  id: string
  title: string
  artists: string
  album: string
  added: string
  duration: string
  /** The cover's URL: a string, so the memo can compare it (Dexie returns fresh arrays). */
  cover: string | undefined
  liked: boolean
  canLike: boolean
  selecting: boolean
  selected: boolean
  menuOpen: boolean
  onToggleSelect: (id: string, extend: boolean) => void
  onToggleLike: (id: string) => void
  onOpenMenu: (id: string, anchor: HTMLElement) => void
}

/**
 * Everything in a row but its drag handle. Memoized on plain values and callbacks that keep
 * their identity, so a reorder or a like re-renders only the rows it changes, also in a list
 * of thousands.
 */
const RowBody = memo(function RowBody({
  id,
  title,
  artists,
  album,
  added,
  duration,
  cover,
  liked,
  canLike,
  selecting,
  selected,
  menuOpen,
  onToggleSelect,
  onToggleLike,
  onOpenMenu,
}: RowBodyProps) {
  return (
    <>
      {selecting ? (
        <label className="grid size-touch shrink-0 cursor-pointer place-items-center lg:size-8 lg:pointer-coarse:size-touch">
          <input
            type="checkbox"
            checked={selected}
            aria-label={`Select ${title}`}
            // React reports a checkbox change from the click, which knows about Shift.
            onChange={(event) => onToggleSelect(id, (event.nativeEvent as MouseEvent).shiftKey)}
            className="size-4 accent-accent"
          />
        </label>
      ) : (
        // The position comes from a CSS counter on the list: no prop to change on a reorder.
        <span
          aria-hidden="true"
          className="hidden w-7 shrink-0 text-right text-sm tabular-nums text-text-muted before:content-[counter(row)] md:block"
        />
      )}
      <CoverArt src={cover} seed={id} icon={Music} rounded="sm" className="size-10" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{title}</p>
        <p className="truncate text-sm text-text-muted">{artists}</p>
      </div>
      <p className="hidden w-1/4 min-w-0 truncate text-sm text-text-muted lg:block">{album}</p>
      <p className="hidden w-28 shrink-0 truncate text-sm text-text-muted xl:block">{added}</p>
      <span className="hidden md:block">
        <IconButton
          label={`Like ${title}`}
          icon={<Heart fill={liked ? 'currentColor' : 'none'} />}
          size="sm"
          pressed={liked}
          disabled={!canLike && !liked}
          data-row-like=""
          onClick={() => onToggleLike(id)}
        />
      </span>
      <span className="hidden w-11 shrink-0 text-right text-sm tabular-nums text-text-muted sm:block">
        {duration}
      </span>
      {/* While selecting on a phone, the selection bar has the actions: room for the title. */}
      <span className={selecting ? 'max-sm:hidden' : undefined}>
        <button
          type="button"
          aria-label={`More options for ${title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-row-menu=""
          className={iconButtonClasses({ size: 'sm' })}
          onClick={(event) => onOpenMenu(id, event.currentTarget)}
        >
          <Ellipsis aria-hidden="true" />
        </button>
      </span>
    </>
  )
})

interface SortableRowProps extends RowBodyProps {
  reorder: boolean
}

function SortableRow({ reorder, ...body }: SortableRowProps) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, style, isDragging } =
    useSortableItem(body.id)
  const { activeId, moving } = useDragState()
  const carried = isDragging || (activeId !== null && moving.has(body.id))
  return (
    <li
      ref={setNodeRef}
      style={style}
      data-row={body.id}
      className={cn(
        'flex items-center gap-2 rounded-lg py-1.5 pr-1 [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto] [counter-increment:row] sm:gap-3',
        !reorder && 'pl-2',
        body.selected
          ? 'bg-accent/12 hover:bg-accent/16 forced-colors:outline forced-colors:outline-[Highlight]'
          : 'hover:bg-text/5',
        carried && 'opacity-40',
      )}
    >
      {reorder && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${body.title}`}
          className={cn(
            'grid size-touch shrink-0 cursor-grab touch-none place-items-center rounded-full text-text-muted hover:text-text active:cursor-grabbing lg:size-8 lg:pointer-coarse:size-touch',
            // Selecting on a phone: the Move menu moves the selection, the title gets the room.
            body.selecting && 'max-sm:hidden',
          )}
        >
          <GripVertical aria-hidden="true" className="size-5" />
        </button>
      )}
      <RowBody {...body} />
    </li>
  )
}

/**
 * A playlist's tracks with every ordering feature: drag and drop (pointer, touch, keyboard),
 * move buttons, multi-select, Shuffle order with Undo and sort views that can be saved as the
 * custom order.
 */
export function TrackList({ listId, rows, undo, kind, name, empty }: TrackListProps) {
  const repo = useLibrary()
  const view = useTrackView(listId)
  const setTrackView = useLibraryViewStore((state) => state.setTrackView)
  const custom = view.key === 'custom'

  const storedIds = useMemo(() => rows.map((row) => row.id as string), [rows])
  const { shown: customIds, apply } = useOptimisticOrder(storedIds)
  const byId = useMemo(() => new Map(rows.map((row) => [row.id as string, row])), [rows])
  const shownRows = useMemo(() => {
    if (!custom) return sortTrackRows(rows, view)
    return customIds.flatMap((id) => byId.get(id) ?? [])
  }, [custom, rows, view, customIds, byId])
  const ids = useMemo(() => shownRows.map((row) => row.id as string), [shownRows])

  // Rows change with every write to the library. The callbacks the memoized rows get read them
  // through refs, so they keep their identity and a like re-renders only its own row.
  const byIdRef = useRef(byId)
  byIdRef.current = byId
  const idsRef = useRef(ids)
  idsRef.current = ids

  const [selecting, setSelecting] = useState(false)
  const selection = useSelection(ids)
  const [adding, setAdding] = useState<Track[] | null>(null)
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const emptyRef = useRef<HTMLDivElement>(null)
  const focusAfter = useFocusAfterRemoval(ids)
  const sortId = useId()
  const plural = 'songs'
  const downloadMenuItem = useDownloadMenuItem()
  const canDownload = useCanDownload()

  const titleOf = useCallback(
    (id: string) => byIdRef.current.get(id)?.track?.title ?? UNKNOWN_TITLE,
    [],
  )

  /** Keeps focus in the list when `gone` leave it: on the next row's `control`, else the list. */
  const keepFocus = useCallback(
    (gone: readonly string[], control: keyof typeof CONTROLS) => {
      const neighbor = neighborAfterRemoval(idsRef.current, new Set(gone))
      focusAfter.expect(
        gone,
        () => rowControl(listRef.current, neighbor, CONTROLS[control]) ?? emptyRef.current,
      )
    },
    [focusAfter],
  )

  const move = useCallback(
    (keys: string[], target: MoveTarget, announce = false) => {
      const next = moveKeys(customIds, keys, target)
      apply(next, () => repo.moveItems(listId, keys, target)).then(
        (moved) => {
          if (!moved || !announce) return
          const moving = new Set(keys)
          const what = next.filter((key) => moving.has(key))
          const noun = (count: number) => countLabel(count, 'song')
          showStatus(moveMessage(what, target, next, { nameOf: titleOf, noun }))
        },
        (error: unknown) => showStatus(failureText(error)),
      )
    },
    [apply, customIds, listId, repo, titleOf],
  )
  /** A move from a menu: drag and drop announces its own moves, menus need the toast. */
  const moveFromMenu = (keys: string[], target: MoveTarget) => move(keys, target, true)

  const toggleLike = useCallback(
    (id: string) => {
      const row = byIdRef.current.get(id)
      if (!row) return
      const title = row.track?.title ?? UNKNOWN_TITLE
      // Unliking in Liked songs removes the row, and its like button with it.
      if (kind === 'liked' && row.liked) keepFocus([id], 'like')
      const done = row.track ? repo.toggleLike(row.track) : repo.unlike(row.id).then(() => false)
      done.then(
        (liked) => showStatus(liked ? 'Saved to Liked songs' : `Removed ${title} from Liked songs`),
        (error: unknown) => {
          focusAfter.cancel()
          showStatus(failureText(error))
        },
      )
    },
    [focusAfter, keepFocus, kind, repo],
  )

  const remove = useCallback(
    async (keys: string[], from: 'menu' | 'selection') => {
      keepFocus(keys, from === 'menu' ? 'menu' : 'select')
      try {
        const removed = await repo.removeTracks(listId, keys as EntityId<'track'>[])
        if (removed === 0) focusAfter.cancel()
        const what = keys.length === 1 ? titleOf(keys[0] as string) : countLabel(removed, 'song')
        showStatus(`Removed ${what} from ${name}`)
      } catch (error) {
        focusAfter.cancel()
        showStatus(failureText(error))
      }
    },
    [focusAfter, keepFocus, listId, name, repo, titleOf],
  )

  const openMenu = useCallback((id: string, anchor: HTMLElement) => setMenu({ id, anchor }), [])
  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      const anchor = menu?.anchor
      setMenu(null)
      if (returnFocus && anchor) returnFocusTo(anchor)
    },
    [menu],
  )

  const saveSorted = async () => {
    try {
      // Through the optimistic order, so the custom view shows the saved order at once.
      await apply(ids, () => repo.setOrder(listId, ids, 'sort'))
      setTrackView(listId, CUSTOM_VIEW)
      showStatus('Saved as the custom order')
    } catch (error) {
      showStatus(failureText(error))
    }
  }

  if (rows.length === 0) {
    // Focusable, so focus has somewhere to go when the last song is removed.
    return (
      <div ref={emptyRef} tabIndex={-1} className="rounded-2xl">
        {empty}
      </div>
    )
  }

  const removeLabel = kind === 'liked' ? 'Remove from Liked songs' : 'Remove from this playlist'
  const menuItems = (id: string): MenuItem[] => {
    const row = byId.get(id)
    const index = ids.indexOf(id)
    const items: MenuItem[] = []
    if (custom) {
      items.push(
        ...moveMenuItems((target) => moveFromMenu([id], target), { index, total: ids.length }),
      )
      items.push({ kind: 'separator', id: 'separator' })
    }
    items.push({
      id: 'add',
      label: 'Add to playlist…',
      icon: ListPlus,
      disabled: row?.track === undefined,
      onSelect: () => row?.track && setAdding([row.track]),
    })
    if (kind !== 'liked') {
      items.push({
        id: 'like',
        label: row?.liked ? 'Remove from Liked songs' : 'Save to Liked songs',
        icon: Heart,
        disabled: !row?.liked && row?.track === undefined,
        onSelect: () => toggleLike(id),
      })
    }
    const download = row && downloadMenuItem(row, { inDownloads: kind === 'downloads' })
    if (download) items.push(download)
    if (kind !== 'downloads') {
      items.push({
        id: 'remove',
        label: removeLabel,
        icon: ListMinus,
        danger: true,
        onSelect: () => remove([id], 'menu'),
      })
    }
    return items
  }

  const selected = [...selection.selected]
  const selectedTracks = selected.flatMap((id) => byId.get(id)?.track ?? [])

  return (
    <div className="space-y-3">
      <OrderToolbar
        sorts={TRACK_SORTS}
        view={view}
        onView={(next) => setTrackView(listId, next)}
        plural={plural}
        canShuffle={custom && rows.length > 1}
        onShuffle={async () => {
          try {
            if (await repo.shuffleOrder(listId)) showStatus(`Shuffled the order of ${name}`)
          } catch (error) {
            showStatus(failureText(error))
          }
        }}
        selecting={selecting}
        onSelecting={(on) => {
          setSelecting(on)
          if (!on) selection.clear()
        }}
        sortId={sortId}
      />
      <OrderNotice
        sorts={TRACK_SORTS}
        view={view}
        undo={undo}
        focusAfter={() => document.getElementById(sortId)}
        onSave={saveSorted}
        onCustom={() => setTrackView(listId, CUSTOM_VIEW)}
        onUndo={async () => {
          try {
            if (await repo.undoOrder(listId)) showStatus('Restored the previous order')
          } catch (error) {
            showStatus(failureText(error))
          }
        }}
      />
      {selecting && (
        <SelectionBar
          count={selected.length}
          noun={plural}
          canMove={custom}
          onMove={(target) => moveFromMenu(selected, target)}
          onClear={selection.clear}
          onSelectAll={selection.selectAll}
        >
          <SelectionAction onClick={() => setAdding(selectedTracks)}>
            <ListPlus aria-hidden="true" />
            <span>
              Add<span className="max-sm:sr-only"> to playlist</span>
            </span>
          </SelectionAction>
          {kind !== 'downloads' && selectedTracks.some(canDownload) && (
            <SelectionAction onClick={() => void downloadTracks(selectedTracks)}>
              <ArrowDownToLine aria-hidden="true" />
              Download
            </SelectionAction>
          )}
          {kind !== 'downloads' && (
            <SelectionAction danger onClick={() => remove(selected, 'selection')}>
              <ListMinus aria-hidden="true" />
              Remove
            </SelectionAction>
          )}
          {kind === 'downloads' && (
            <SelectionAction
              danger
              onClick={() =>
                void removeDownloads(
                  selected.map((id) => ({ id: id as EntityId<'track'>, title: titleOf(id) })),
                )
              }
            >
              <CircleMinus aria-hidden="true" />
              Remove
            </SelectionAction>
          )}
        </SelectionBar>
      )}
      <div
        aria-hidden="true"
        className="hidden items-center gap-3 border-b border-border px-1 pb-2 text-xs font-semibold tracking-wide text-text-muted uppercase lg:flex"
      >
        {custom && <span className="w-8 shrink-0" />}
        <span className="w-7 shrink-0 text-right">#</span>
        <span className="w-10 shrink-0" />
        <span className="flex-1">Title</span>
        <span className="w-1/4">Album</span>
        <span className="hidden w-28 shrink-0 xl:block">Date added</span>
        <span className="w-8 shrink-0" />
        <span className="flex w-11 shrink-0 justify-end">
          <Clock3 className="size-4" />
        </span>
        <span className="w-8 shrink-0" />
      </div>
      <SortableList
        ids={ids}
        enabled={custom}
        selection={selection.selected}
        labelOf={titleOf}
        plural={plural}
        onMove={move}
      >
        <ol ref={listRef} aria-label={`Songs in ${name}`} className="-mx-1 [counter-reset:row]">
          {shownRows.map((row) => (
            <SortableRow
              key={row.id}
              reorder={custom}
              id={row.id}
              title={row.track?.title ?? UNKNOWN_TITLE}
              artists={artistNames(row.track)}
              album={row.track?.album?.name ?? ''}
              added={addedLabel(row.addedAt)}
              duration={trackDuration(row.track)}
              cover={artworkUrl(row.track?.artwork, 80)}
              liked={row.liked}
              canLike={row.track !== undefined}
              selecting={selecting}
              selected={selection.selected.has(row.id)}
              menuOpen={menu?.id === row.id}
              onToggleSelect={selection.toggle}
              onToggleLike={toggleLike}
              onOpenMenu={openMenu}
            />
          ))}
        </ol>
      </SortableList>
      {menu && (
        <MenuPopup
          anchor={menu.anchor}
          items={menuItems(menu.id)}
          label={`More options for ${titleOf(menu.id)}`}
          onClose={closeMenu}
        />
      )}
      <AddToPlaylistDialog tracks={adding} onClose={() => setAdding(null)} />
    </div>
  )
}
