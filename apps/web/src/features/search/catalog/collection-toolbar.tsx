import type { QueueContext, SourceId, Track } from '@fxm/core'
import { Play, Shuffle } from 'lucide-react'
import { IconButton } from '../../../components/ui/icon-button'
import { useMediaActions } from '../actions'
import { isYouTubeSource } from '../sources'
import { useSourcesSnapshot } from '../sources-context'
import { ActionMenu, type MenuAction } from './action-menu'
import { LiteNote } from './lite-note'
import { useTracksMenu } from './track-list'

/**
 * The actions under an album, artist or playlist header: play, shuffle, and a menu with play
 * next, add to queue, add to playlist and (where the tier allows) download, plus `extraItems`
 * such as "Go to artist". Each appears once its stage is wired in. In the Lite tier, a note
 * under them says why YouTube items have no download and no equalizer.
 *
 * Play plays in order and Shuffle shuffles, whatever the player's shuffle was before: the
 * player keeps its shuffle setting for a new queue unless told otherwise.
 */
export function CollectionToolbar({
  name,
  source,
  tracks,
  context,
  extraItems = [],
}: {
  /** The collection's name, for labels and messages. */
  name: string
  /** Where the collection comes from. */
  source: SourceId
  /** What plays, already filtered for the catalog mode. */
  tracks: readonly Track[]
  context: QueueContext
  extraItems?: readonly MenuAction[]
}) {
  const { playback } = useMediaActions()
  const { capabilities } = useSourcesSnapshot()
  const menu = useTracksMenu(tracks, name)
  const empty = tracks.length === 0
  return (
    <div className="space-y-4">
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
              onClick={() => playback.play(tracks, { shuffle: false, context })}
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
      {capabilities.youtube === 'simple' && isYouTubeSource(source) && (
        <LiteNote className="mx-auto max-w-md sm:mx-0" />
      )}
    </div>
  )
}
