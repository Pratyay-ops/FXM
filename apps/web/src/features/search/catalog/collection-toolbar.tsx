import type { Track } from '@fxm/core'
import { Play, Shuffle } from 'lucide-react'
import { IconButton } from '../../../components/ui/icon-button'
import { type PlayContext, useMediaActions } from '../actions'
import { ActionMenu, type MenuAction } from './action-menu'
import { useTracksMenu } from './track-list'

/**
 * The actions under an album, artist or playlist header: play, shuffle, and a menu with play
 * next, add to queue, add to playlist and (where the tier allows) download, plus `extraItems`
 * such as "Go to artist". Each appears once its stage is wired in.
 */
export function CollectionToolbar({
  name,
  tracks,
  context,
  extraItems = [],
}: {
  /** The collection's name, for labels and messages. */
  name: string
  /** What plays, already filtered for the catalog mode. */
  tracks: readonly Track[]
  context: PlayContext
  extraItems?: readonly MenuAction[]
}) {
  const { playback } = useMediaActions()
  const menu = useTracksMenu(tracks, name)
  const empty = tracks.length === 0
  return (
    <div className="flex items-center justify-center gap-2 sm:justify-start">
      {playback && (
        <>
          <IconButton
            label={`Play ${name}`}
            // The play triangle's visual center sits left of its box: nudge it right.
            icon={<Play fill="currentColor" strokeWidth={0} className="ml-0.5" />}
            size="custom"
            variant="accent"
            className="mr-1 size-14 [&_svg]:size-6"
            disabled={empty}
            onClick={() => playback.play(tracks, { context })}
          />
          <IconButton
            label={`Shuffle ${name}`}
            icon={<Shuffle />}
            size="custom"
            className="size-12 [&_svg]:size-6"
            disabled={empty}
            onClick={() => playback.play(tracks, { shuffle: true, context })}
          />
        </>
      )}
      <ActionMenu
        label={`More options for ${name}`}
        items={[...menu, ...extraItems]}
        size="custom"
        className="size-12 [&_svg]:size-6"
      />
    </div>
  )
}
