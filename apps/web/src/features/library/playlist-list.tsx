import { Copy, Ellipsis, GripVertical, ListMinus, Pencil, Trash } from 'lucide-react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { iconButtonClasses } from '../../components/ui/icon-button'
import { useLibrary } from '../../db/hooks'
import { type MoveTarget, moveKeys, sameOrder } from '../../db/ordering'
import type { PlaylistSummary } from '../../db/repo'
import { PLAYLISTS_ORDER_ID } from '../../db/types'
import { cn } from '../../lib/cn'
import { CoverArt } from './cover-art'
import { failureText } from './failure'
import { artworkUrl, countLabel } from './format'
import {
  moveMenuItems,
  moveMessage,
  OrderNotice,
  OrderToolbar,
  SelectionBar,
  useOptimisticOrder,
} from './order-controls'
import { playlistIcon, playlistPath, playlistSubtitle } from './paths'
import { duplicatePlaylist, type PlaylistRef } from './playlist-dialogs'
import { PLAYLIST_SORTS, sortPlaylists } from './sort'
import { SortableList, useDragState, useSortableItem } from './sortable'
import { showStatus } from './status'
import { type MenuItem, MenuPopup, returnFocusTo } from './ui/menu'
import { neighborAfterRemoval, rowControl, useFocusAfterRemoval } from './use-focus-after-removal'
import { useSelection } from './use-selection'
import { CUSTOM_VIEW, useLibraryViewStore } from './view-store'

/**
 * The ordering of the list of playlists, shared by the Library page and the sidebar: the
 * view (custom order or a sort), moves, Shuffle order, Undo and "Save as custom order".
 */
export function usePlaylistOrdering(items: readonly PlaylistSummary[]) {
  const repo = useLibrary()
  const view = useLibraryViewStore((state) => state.playlistView)
  const setView = useLibraryViewStore((state) => state.setPlaylistView)
  const custom = view.key === 'custom'

  const storedIds = useMemo(() => items.map((item) => item.id as string), [items])
  const { shown, apply } = useOptimisticOrder(storedIds)
  const byId = useMemo(() => new Map(items.map((item) => [item.id as string, item])), [items])
  const shownItems = useMemo(
    () => (custom ? shown.flatMap((id) => byId.get(id) ?? []) : sortPlaylists(items, view)),
    [custom, shown, byId, items, view],
  )
  const ids = useMemo(() => shownItems.map((item) => item.id as string), [shownItems])

  // "Save as custom order" switches to the custom view only once the saved order is in the
  // data, which the sidebar and the Library page share (`usePlaylistList`): until then the
  // sort shows that very order, so neither list ever shows the old one in between.
  const storedRef = useRef(storedIds)
  storedRef.current = storedIds
  const switchAfterSave = useRef<readonly string[] | null>(null)
  useEffect(() => {
    const before = switchAfterSave.current
    if (before === null || sameOrder(storedIds, before)) return
    switchAfterSave.current = null
    setView(CUSTOM_VIEW)
  }, [storedIds, setView])

  /** Moves playlists; one moved from a menu is announced (drag and drop announces its own). */
  const move = useCallback(
    (keys: string[], target: MoveTarget, announce = false) => {
      const next = moveKeys(shown, keys, target)
      apply(next, () => repo.moveItems(PLAYLISTS_ORDER_ID, keys, target)).then(
        (moved) => {
          if (!moved || !announce) return
          const moving = new Set(keys)
          const message = moveMessage(
            next.filter((key) => moving.has(key)),
            target,
            next,
            {
              nameOf: (key) => byId.get(key)?.name ?? 'Playlist',
              noun: (count) => countLabel(count, 'playlist'),
            },
          )
          showStatus(message)
        },
        (error: unknown) => showStatus(failureText(error)),
      )
    },
    [apply, byId, repo, shown],
  )

  const run = useCallback(async (action: () => Promise<boolean>, done: string) => {
    try {
      if (await action()) showStatus(done)
    } catch (error) {
      showStatus(failureText(error))
    }
  }, [])

  return {
    view,
    setView,
    custom,
    items: shownItems,
    ids,
    byId,
    move,
    moveFromMenu: (keys: string[], target: MoveTarget) => move(keys, target, true),
    shuffle: () =>
      run(() => repo.shuffleOrder(PLAYLISTS_ORDER_ID), 'Shuffled the order of your playlists'),
    undo: () => run(() => repo.undoOrder(PLAYLISTS_ORDER_ID), 'Restored the previous order'),
    saveSorted: () =>
      run(async () => {
        const before = storedRef.current
        const saved = await repo.setOrder(PLAYLISTS_ORDER_ID, ids, 'sort')
        // Nothing changed, or the new order has arrived already: switch now.
        if (!saved || !sameOrder(storedRef.current, before)) setView(CUSTOM_VIEW)
        else switchAfterSave.current = before
        return true
      }, 'Saved as the custom order'),
    showCustom: () => setView(CUSTOM_VIEW),
  }
}

/** What a playlist's menu needs to do besides moving. */
export interface PlaylistActions {
  rename: (playlist: PlaylistRef) => void
  /**
   * Asks to delete a playlist. `focusAfter` names what takes focus once it is gone: the
   * button that opened the dialog goes with it.
   */
  remove: (playlist: PlaylistRef, focusAfter?: () => HTMLElement | null) => void
  /** Removes a followed playlist from the library; resolves to whether that worked. */
  unfollow: (item: PlaylistSummary) => Promise<boolean>
}

/**
 * The actions of a list's rows, keeping focus in the list when a row goes away: after a
 * delete or an unfollow, the next row's menu button gets it (the previous row's for the last).
 */
export function useRowActions(
  actions: PlaylistActions,
  ids: readonly string[],
  list: { readonly current: HTMLElement | null },
): PlaylistActions {
  const focusAfter = useFocusAfterRemoval(ids)
  const next = (id: string) => {
    const neighbor = neighborAfterRemoval(ids, new Set([id]))
    return () => rowControl(list.current, neighbor, '[data-row-menu]')
  }
  return {
    rename: actions.rename,
    remove: (playlist) => actions.remove(playlist, next(playlist.id)),
    unfollow: async (item) => {
      focusAfter.expect([item.id], next(item.id))
      const done = await actions.unfollow(item)
      if (!done) focusAfter.cancel()
      return done
    },
  }
}

/** The menu of one playlist: moves in the custom order, then what the playlist allows. */
export function playlistMenuItems(
  item: PlaylistSummary,
  {
    custom,
    index,
    total,
    move,
    actions,
  }: {
    custom: boolean
    index: number
    total: number
    /** Moves from the menu, announced. */
    move: (keys: string[], target: MoveTarget) => void
    actions: PlaylistActions
  },
): MenuItem[] {
  const items: MenuItem[] = []
  if (custom) {
    items.push(...moveMenuItems((target) => move([item.id], target), { index, total }))
    items.push({ kind: 'separator', id: 'separator' })
  }
  const ref: PlaylistRef = { id: item.id, name: item.name, description: item.description }
  if (item.origin === 'followed') {
    items.push({
      id: 'unfollow',
      label: 'Remove from your library',
      icon: ListMinus,
      onSelect: () => actions.unfollow(item),
    })
    return items
  }
  if (!item.system) {
    items.push({
      id: 'edit',
      label: 'Edit details…',
      icon: Pencil,
      onSelect: () => actions.rename(ref),
    })
  }
  items.push({
    id: 'duplicate',
    label: 'Duplicate',
    icon: Copy,
    onSelect: () => duplicatePlaylist(ref),
  })
  if (!item.system) {
    items.push({
      id: 'delete',
      label: 'Delete…',
      icon: Trash,
      danger: true,
      onSelect: () => actions.remove(ref),
    })
  }
  return items
}

/** Unfollows a followed playlist and confirms it; resolves to whether that worked. */
export function useUnfollow() {
  const repo = useLibrary()
  return useCallback(
    (item: PlaylistSummary): Promise<boolean> =>
      repo.unfollow(item.id).then(
        () => {
          showStatus(`Removed ${item.name} from your library`)
          return true
        },
        (error: unknown) => {
          showStatus(failureText(error))
          return false
        },
      ),
    [repo],
  )
}

interface RowProps {
  id: string
  name: string
  subtitle: string
  cover: string | undefined
  system: PlaylistSummary['system']
  reorder: boolean
  selecting: boolean
  selected: boolean
  menuOpen: boolean
  onToggleSelect: (id: string, extend: boolean) => void
  onOpenMenu: (id: string, anchor: HTMLElement) => void
}

/** A playlist row but its drag handle, memoized on plain values. */
const RowBody = memo(function RowBody({
  id,
  name,
  subtitle,
  cover,
  system,
  selecting,
  selected,
  menuOpen,
  onToggleSelect,
  onOpenMenu,
}: Omit<RowProps, 'reorder'>) {
  return (
    <>
      {selecting && (
        <label className="grid size-touch shrink-0 cursor-pointer place-items-center lg:size-8 lg:pointer-coarse:size-touch">
          <input
            type="checkbox"
            checked={selected}
            aria-label={`Select ${name}`}
            onChange={(event) => onToggleSelect(id, (event.nativeEvent as MouseEvent).shiftKey)}
            className="size-4 accent-accent"
          />
        </label>
      )}
      <Link
        to={playlistPath(id as PlaylistSummary['id'])}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 pr-2 focus-visible:outline-offset-0"
      >
        <CoverArt
          src={cover}
          seed={`playlist:${id}`}
          icon={playlistIcon({ system })}
          rounded="sm"
          className="size-12"
        />
        <span className="min-w-0">
          <span className="block truncate font-semibold">{name}</span>
          <span className="block truncate text-sm text-text-muted">{subtitle}</span>
        </span>
      </Link>
      <span className={selecting ? 'max-sm:hidden' : undefined}>
        <button
          type="button"
          aria-label={`More options for ${name}`}
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

function SortableRow({ reorder, ...body }: RowProps) {
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
        'flex items-center gap-2 rounded-lg p-1 sm:gap-3',
        !reorder && 'pl-2',
        body.selected ? 'bg-accent/12 hover:bg-accent/16' : 'hover:bg-text/5',
        carried && 'opacity-40',
      )}
    >
      {reorder && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${body.name}`}
          className={cn(
            'grid size-touch shrink-0 cursor-grab touch-none place-items-center rounded-full text-text-muted hover:text-text active:cursor-grabbing lg:size-8 lg:pointer-coarse:size-touch',
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

/** The Library page's list of playlists, with every ordering feature. */
export function PlaylistList({
  items: stored,
  undo,
  actions,
}: {
  items: readonly PlaylistSummary[]
  undo: Parameters<typeof OrderNotice>[0]['undo']
  actions: PlaylistActions
}) {
  const ordering = usePlaylistOrdering(stored)
  const { custom, ids, byId, move, moveFromMenu } = ordering
  const [selecting, setSelecting] = useState(false)
  const selection = useSelection(ids)
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const rowActions = useRowActions(actions, ids, listRef)
  const sortId = useId()
  const nameOf = useCallback((id: string) => byId.get(id)?.name ?? 'Playlist', [byId])
  const openMenu = useCallback((id: string, anchor: HTMLElement) => setMenu({ id, anchor }), [])
  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      const anchor = menu?.anchor
      setMenu(null)
      if (returnFocus && anchor) returnFocusTo(anchor)
    },
    [menu],
  )
  const selected = [...selection.selected]
  const menuItem = menu ? byId.get(menu.id) : undefined

  return (
    <div className="space-y-3">
      <OrderToolbar
        sorts={PLAYLIST_SORTS}
        view={ordering.view}
        onView={ordering.setView}
        plural="playlists"
        canShuffle={custom && ids.length > 1}
        onShuffle={ordering.shuffle}
        selecting={selecting}
        onSelecting={(on) => {
          setSelecting(on)
          if (!on) selection.clear()
        }}
        sortId={sortId}
      />
      <OrderNotice
        sorts={PLAYLIST_SORTS}
        view={ordering.view}
        undo={undo}
        focusAfter={() => document.getElementById(sortId)}
        onSave={ordering.saveSorted}
        onCustom={ordering.showCustom}
        onUndo={ordering.undo}
      />
      {selecting && (
        <SelectionBar
          count={selected.length}
          noun="playlists"
          canMove={custom}
          onMove={(target) => moveFromMenu(selected, target)}
          onClear={selection.clear}
          onSelectAll={selection.selectAll}
        />
      )}
      <SortableList
        ids={ids}
        enabled={custom}
        selection={selection.selected}
        labelOf={nameOf}
        plural="playlists"
        onMove={move}
      >
        <ol ref={listRef} aria-label="Your playlists" className="-mx-1">
          {ordering.items.map((item) => (
            <SortableRow
              key={item.id}
              id={item.id}
              name={item.name}
              subtitle={playlistSubtitle(item)}
              cover={artworkUrl(item.artwork, 96)}
              system={item.system}
              reorder={custom}
              selecting={selecting}
              selected={selection.selected.has(item.id)}
              menuOpen={menu?.id === item.id}
              onToggleSelect={selection.toggle}
              onOpenMenu={openMenu}
            />
          ))}
        </ol>
      </SortableList>
      {menu && menuItem && (
        <MenuPopup
          anchor={menu.anchor}
          label={`More options for ${menuItem.name}`}
          items={playlistMenuItems(menuItem, {
            custom,
            index: ids.indexOf(menu.id),
            total: ids.length,
            move: moveFromMenu,
            actions: rowActions,
          })}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
