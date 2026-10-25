import { Copy, Ellipsis, GripVertical, ListMinus, Pencil, Trash } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { iconButtonClasses } from '../../components/ui/icon-button'
import { useLibrary } from '../../db/hooks'
import { type MoveTarget, moveKeys } from '../../db/ordering'
import type { PlaylistSummary } from '../../db/repo'
import { PLAYLISTS_ORDER_ID } from '../../db/types'
import { cn } from '../../lib/cn'
import { CoverArt } from './cover-art'
import { artworkUrl } from './format'
import {
  moveMenuItems,
  OrderNotice,
  OrderToolbar,
  SelectionBar,
  useOptimisticOrder,
} from './order-controls'
import { playlistIcon, playlistPath, playlistSubtitle } from './paths'
import { duplicatePlaylist, failureText, type PlaylistRef } from './playlist-dialogs'
import { PLAYLIST_SORTS, sortPlaylists } from './sort'
import { SortableList, useDragState, useSortableItem } from './sortable'
import { showStatus } from './status'
import { type MenuItem, MenuPopup } from './ui/menu'
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

  const move = useCallback(
    (keys: string[], target: MoveTarget) => {
      apply(moveKeys(shown, keys, target), () =>
        repo.moveItems(PLAYLISTS_ORDER_ID, keys, target),
      ).catch((error: unknown) => showStatus(failureText(error)))
    },
    [apply, repo, shown],
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
    shuffle: () =>
      run(() => repo.shuffleOrder(PLAYLISTS_ORDER_ID), 'Shuffled the order of your playlists'),
    undo: () => run(() => repo.undoOrder(PLAYLISTS_ORDER_ID), 'Restored the previous order'),
    saveSorted: () =>
      run(async () => {
        const saved = await repo.setOrder(PLAYLISTS_ORDER_ID, ids, 'sort')
        setView(CUSTOM_VIEW)
        return saved
      }, 'Saved as the custom order'),
    showCustom: () => setView(CUSTOM_VIEW),
  }
}

/** What a playlist's menu needs to do besides moving. */
export interface PlaylistActions {
  rename: (playlist: PlaylistRef) => void
  remove: (playlist: PlaylistRef) => void
  unfollow: (item: PlaylistSummary) => void
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

/** Unfollows a followed playlist and confirms it. */
export function useUnfollow() {
  const repo = useLibrary()
  return useCallback(
    (item: PlaylistSummary) => {
      repo.unfollow(item.id).then(
        () => showStatus(`Removed ${item.name} from your library`),
        (error: unknown) => showStatus(failureText(error)),
      )
    },
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
        <label className="grid size-touch shrink-0 cursor-pointer place-items-center lg:size-8">
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
  const { custom, ids, byId, move } = ordering
  const [selecting, setSelecting] = useState(false)
  const selection = useSelection(ids)
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const nameOf = useCallback((id: string) => byId.get(id)?.name ?? 'Playlist', [byId])
  const openMenu = useCallback((id: string, anchor: HTMLElement) => setMenu({ id, anchor }), [])
  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      const anchor = menu?.anchor
      setMenu(null)
      if (returnFocus && anchor) requestAnimationFrame(() => anchor.isConnected && anchor.focus())
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
      />
      <OrderNotice
        sorts={PLAYLIST_SORTS}
        view={ordering.view}
        undo={undo}
        onSave={ordering.saveSorted}
        onCustom={ordering.showCustom}
        onUndo={ordering.undo}
      />
      {selecting && (
        <SelectionBar
          count={selected.length}
          noun="playlists"
          canMove={custom}
          onMove={(target) => move(selected, target)}
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
        <ol aria-label="Your playlists" className="-mx-1">
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
            move,
            actions,
          })}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
