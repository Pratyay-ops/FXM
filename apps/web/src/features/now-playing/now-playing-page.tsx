import { ListMusic } from 'lucide-react'
import { useId } from 'react'
import { useSearchParams } from 'react-router'
import { Artwork } from '../../components/ui/artwork'
import { PageTitle } from '../../components/ui/page'
import { Skeleton } from '../../components/ui/skeleton'
import { type TabItem, TabPanel, Tabs } from '../../components/ui/tabs'
import { LikeButton, PlayerControls, SeekBar } from '../player/controls'
import { PLACEHOLDER_TRACK } from '../player/player-store'

type Panel = 'lyrics' | 'queue'

const PANELS: readonly TabItem<Panel>[] = [
  { value: 'lyrics', label: 'Lyrics' },
  { value: 'queue', label: 'Queue' },
]

// Unique widths double as React keys.
const LYRIC_LINES = ['w-3/4', 'w-1/2', 'w-5/6', 'w-2/3', 'w-3/5', 'w-4/5', 'w-7/12', 'w-5/12']

function LyricsPlaceholder() {
  return (
    <div className="space-y-5">
      <p className="text-sm text-text-muted">Synced lyrics will scroll here as the song plays.</p>
      <div aria-hidden="true" className="space-y-4">
        {LYRIC_LINES.map((width) => (
          <Skeleton key={width} className={`h-6 rounded-full md:h-7 ${width}`} />
        ))}
      </div>
    </div>
  )
}

function QueuePlaceholder() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-text-muted uppercase">
          Now playing
        </h3>
        <div className="flex items-center gap-3 rounded-lg bg-elevated p-2">
          <Artwork seed={PLACEHOLDER_TRACK.seed} rounded="sm" className="size-12" />
          <div className="min-w-0">
            <p className="truncate font-semibold text-accent">{PLACEHOLDER_TRACK.title}</p>
            <p className="truncate text-sm text-text-muted">{PLACEHOLDER_TRACK.artist}</p>
          </div>
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-text-muted uppercase">
          Next up
        </h3>
        <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-4 py-10 text-center">
          <ListMusic aria-hidden="true" className="size-7 text-text-muted" strokeWidth={1.75} />
          <p className="mt-3 font-semibold">Your queue is empty</p>
          <p className="mt-1 max-w-xs text-sm text-text-muted">
            Songs you add with “Play next” or “Add to queue” show up here.
          </p>
        </div>
      </div>
    </div>
  )
}

export function NowPlayingPage() {
  const [params, setParams] = useSearchParams()
  const panel: Panel = params.get('tab') === 'queue' ? 'queue' : 'lyrics'
  const tabsId = useId()

  return (
    <div className="pt-2 md:space-y-8 md:pt-4">
      <PageTitle hideOnPhone>Now playing</PageTitle>
      <div className="grid gap-8 md:grid-cols-2 md:gap-10 xl:gap-16">
        <section aria-label="Track" className="mx-auto w-full max-w-sm md:max-w-md">
          {/* Stage 2.3 mounts the visible YouTube player in this artwork area. */}
          <Artwork
            seed={PLACEHOLDER_TRACK.seed}
            rounded="xl"
            className="aspect-square w-full shadow-xl"
          />
          <div className="mt-6 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-2xl font-bold tracking-tight">
                {PLACEHOLDER_TRACK.title}
              </h2>
              <p className="truncate text-text-muted">{PLACEHOLDER_TRACK.artist}</p>
            </div>
            <LikeButton size="md" />
          </div>
          {/* From 768px the player bar has these controls. */}
          <div className="mt-4 md:hidden">
            <SeekBar />
            <PlayerControls size="lg" className="mt-3" />
          </div>
        </section>

        <section aria-label="Lyrics and queue" className="min-w-0">
          <Tabs
            label="Now playing panels"
            items={PANELS}
            value={panel}
            onChange={(next) =>
              setParams(next === 'queue' ? { tab: 'queue' } : {}, {
                replace: true,
                preventScrollReset: true,
              })
            }
            id={tabsId}
          />
          <TabPanel id={tabsId} value={panel} className="mt-4">
            {panel === 'lyrics' ? <LyricsPlaceholder /> : <QueuePlaceholder />}
          </TabPanel>
        </section>
      </div>
    </div>
  )
}
