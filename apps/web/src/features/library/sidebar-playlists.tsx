import type { EntityId } from '@fxm/core'
import { ArrowDownUp, Dices, Ellipsis, Plus, Save, Undo2 } from 'lucide-react'
import { memo, useCallback, useId, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import { IconButton, iconButtonClasses } from '../../components/ui/icon-button'
import { usePlaylistList } from '../../db/hooks'
import type { PlaylistSummary } from '../../db/repo'
import { cn } from '../../lib/cn'
import { CoverArt } from './cover-art'
import { artworkUrl } from './format'
import { playlistIcon, playlistPath, playlistSubtitle } from './paths'
import { usePlaylistDialogs } from './playlist-dialogs'
import { playlistMenuItems, usePlaylistOrdering, useUnfollow } from './playlist-list'
import { directionLabel, PLAYLIST_SORTS } from './sort'
import { SortableList, useDragState, useSortableItem } from './sortable'
import { Menu, type MenuItem, MenuPopup } from './ui/menu'
import { defaultDirection } from './view-store'

const NO_PLAYLISTS: readonly PlaylistSummary[] = []
const NO_SELECTION: ReadonlySet<string> = new Set()

interface RowProps {
  item: PlaylistSummary
  menuOpen: boolean
  onOpenMenu: (id: string, anchor: HTMLElement) => void
}

/** The content of a row's link, memoized on plain values. */
const RowLink = memo(function RowLink({
  id,
  name,
  subtitle,
  cover,
  system,
}: {
  id: string
  name: string
  subtitle: string
  cover: string | undefined
  system: PlaylistSummary['system']
}) {
  return (
    <>
      <CoverArt
        src={cover}
        seed={`playlist:${id}`}
        icon={playlistIcon({ system })}
        rounded="sm"
        className="size-10"
      />
      <span className="sr-only min-w-0 lg:not-sr-only">
        <span className="block truncate text-sm font-semibold">{name}</span>
        <span className="block truncate text-xs text-text-muted">{subtitle}</span>
      </span>
    </>
  )
})

function SidebarRow({ item, menuOpen, onOpenMenu }: RowProps) {
  // The link itself starts a drag (mouse after a few pixels, touch after a long press), so
  // it gets the listeners only: the sortable attributes would turn it into a button.
  const { setNodeRef, setActivatorNodeRef, listeners, style, isDragging } = useSortableItem(item.id)
  const { activeId, moving } = useDragState()
  const carried = isDragging || (activeId !== null && moving.has(item.id))
  return (
    <li ref={setNodeRef} style={style} className={cn('group relative', carried && 'opacity-40')}>
      <NavLink
        ref={setActivatorNodeRef}
        {...listeners}
        to={playlistPath(item.id)}
        title={item.name}
        // Native link dragging would fight the drag and drop.
        draggable={false}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-3 rounded-md p-2 transition-colors select-none [-webkit-touch-callout:none] max-lg:justify-center lg:pr-10',
            isActive ? 'bg-elevated' : 'hover:bg-text/6',
          )
        }
      >
        <RowLink
          id={item.id}
          name={item.name}
          subtitle={playlistSubtitle(item)}
          cover={artworkUrl(item.artwork, 80)}
          system={item.system}
        />
      </NavLink>
      {/* Shown on hover and focus with a mouse, always on touch screens; only from 1024px. */}
      <span
        className={cn(
          'absolute top-1/2 right-1 -translate-y-1/2 max-lg:hidden',
          menuOpen
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
        )}
      >
        <button
          type="button"
          aria-label={`More options for ${item.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => onOpenMenu(item.id, event.currentTarget)}
          className={iconButtonClasses({ size: 'sm' })}
        >
          <Ellipsis aria-hidden="true" />
        </button>
      </span>
    </li>
  )
}

/**
 * "Your playlists" in the sidebar: every playlist in the saved custom order, which can be
 * changed right here by drag and drop, the move entries of each playlist's menu, Shuffle order
 * or a sort saved as the custom order.
 */
export function SidebarPlaylists() {
  const live = usePlaylistList()
  const items = live.status === 'ready' ? live.data.items : NO_PLAYLISTS
  const undo = live.status === 'ready' ? live.data.undo : undefined
  const ordering = usePlaylistOrdering(items)
  const { custom, ids, byId, move, view } = ordering
  const headingId = useId()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const dialogs = usePlaylistDialogs({
    onCreated: (id) => navigate(playlistPath(id)),
    onDeleted: (id: EntityId<'playlist'>) => {
      if (pathname === playlistPath(id)) navigate('/library')
    },
  })
  const unfollow = useUnfollow()
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const openMenu = useCallback((id: string, anchor: HTMLElement) => setMenu({ id, anchor }), [])
  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      const anchor = menu?.anchor
      setMenu(null)
      if (returnFocus && anchor) requestAnimationFrame(() => anchor.isConnected && anchor.focus())
    },
    [menu],
  )
  const nameOf = useCallback((id: string) => byId.get(id)?.name ?? 'Playlist', [byId])

  const arrange: MenuItem[] = [
    {
      kind: 'group',
      id: 'sort',
      label: 'Sort by',
      items: PLAYLIST_SORTS.map((sort) => ({
        kind: 'radio',
        id: `sort-${sort.key}`,
        label: sort.label,
        checked: view.key === sort.key,
        onSelect: () =>
          ordering.setView({
            key: sort.key,
            direction: sort.key === view.key ? view.direction : defaultDirection(sort.key),
          }),
      })),
    },
  ]
  if (!custom) {
    arrange.push({
      kind: 'group',
      id: 'direction',
      label: 'Order',
      items: (['asc', 'desc'] as const).map((direction) => ({
        kind: 'radio',
        id: `direction-${direction}`,
        label: directionLabel(view.key, direction),
        checked: view.direction === direction,
        onSelect: () => ordering.setView({ key: view.key, direction }),
      })),
    })
  }
  arrange.push({ kind: 'separator', id: 'separator' })
  if (custom) {
    arrange.push({
      id: 'shuffle',
      label: 'Shuffle order',
      icon: Dices,
      disabled: ids.length < 2,
      onSelect: ordering.shuffle,
    })
    if (undo) {
      arrange.push({
        id: 'undo',
        label: undo.action === 'shuffle' ? 'Undo shuffle' : 'Undo saved sort',
        icon: Undo2,
        onSelect: ordering.undo,
      })
    }
  } else {
    arrange.push({
      id: 'save',
      label: 'Save as custom order',
      icon: Save,
      onSelect: ordering.saveSorted,
    })
  }

  const menuItem = menu ? byId.get(menu.id) : undefined

  return (
    <section aria-labelledby={headingId} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 lg:pr-3 lg:pb-1 lg:pl-6">
        <h2
          id={headingId}
          className="sr-only lg:not-sr-only lg:mr-auto lg:text-xs lg:font-bold lg:tracking-[0.12em] lg:text-text-muted lg:uppercase"
        >
          Your playlists
        </h2>
        <span className="hidden items-center gap-1 lg:flex">
          <IconButton label="New playlist" icon={<Plus />} size="sm" onClick={dialogs.create} />
          <Menu
            label="Arrange playlists"
            iconOnly
            items={arrange}
            className={iconButtonClasses({ size: 'sm', highlighted: !custom })}
          >
            <ArrowDownUp aria-hidden="true" />
          </Menu>
        </span>
      </div>
      {live.status === 'error' && (
        <p className="sr-only px-6 text-sm text-text-muted lg:not-sr-only">
          Your playlists can't be shown in this browser window.
        </p>
      )}
      <SortableList
        ids={ids}
        enabled={custom}
        selection={NO_SELECTION}
        labelOf={nameOf}
        plural="playlists"
        onMove={move}
        activator="row"
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* pt-1: the scroll box clips, so leave room for the first row's focus ring. */}
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pt-1 pb-4 scrollbar-thin">
          {ordering.items.map((item) => (
            <SidebarRow
              key={item.id}
              item={item}
              menuOpen={menu?.id === item.id}
              onOpenMenu={openMenu}
            />
          ))}
        </ul>
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
            actions: { rename: dialogs.rename, remove: dialogs.remove, unfollow },
          })}
          onClose={closeMenu}
        />
      )}
      {dialogs.dialogs}
    </section>
  )
}
