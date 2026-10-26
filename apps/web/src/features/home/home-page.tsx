import { Search, SlidersHorizontal } from 'lucide-react'
import { useId } from 'react'
import { Link } from 'react-router'
import { PageWash } from '../../components/media/collection-header'
import { CardScroller, SongGrid } from '../../components/media/placeholders'
import { buttonClasses } from '../../components/ui/button'
import { Shelf } from '../../components/ui/page'
import { InstallCard } from '../pwa/install-card'
import { CATALOG_MODE_LABELS } from '../settings/options'
import { useSettingsStore } from '../settings/settings-store'

/** "Good morning" before noon, "Good afternoon" until 6 pm, "Good evening" otherwise. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function WelcomeCard() {
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-lg sm:p-7"
      style={{
        backgroundImage:
          'radial-gradient(90% 120% at 100% 0%, color-mix(in oklab, var(--color-accent) 22%, transparent), transparent 70%)',
      }}
    >
      <div className="max-w-xl">
        <p className="text-xs font-bold tracking-[0.14em] text-accent uppercase">
          {CATALOG_MODE_LABELS[catalogMode]} mode
        </p>
        <h2 id={titleId} className="mt-2 text-2xl font-extrabold tracking-tight sm:text-3xl">
          Play practically any song
        </h2>
        <p className="mt-2 text-text-muted">
          {catalogMode === 'music'
            ? 'Clean album audio from the YouTube Music catalog. Switch to Music + Video for covers, live sets and remixes.'
            : 'Songs plus any YouTube video – covers, live sets, remixes – all played as music.'}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link to="/search" className={buttonClasses()}>
            <Search aria-hidden="true" />
            Search music
          </Link>
          <Link to="/settings" className={buttonClasses({ variant: 'secondary' })}>
            <SlidersHorizontal aria-hidden="true" />
            Change mode
          </Link>
        </div>
      </div>
    </section>
  )
}

export function HomePage() {
  const greeting = greetingFor(new Date().getHours())
  return (
    <div className="space-y-10 md:space-y-12">
      <PageWash color="color-mix(in oklab, var(--color-accent) 24%, transparent)" />
      <div className="pt-4 md:pt-6">
        <h1 className="text-display font-extrabold">{greeting}</h1>
        <p className="mt-2 text-text-muted md:text-lg">
          Free music from everywhere. No account, no ads from FXM.
        </p>
      </div>

      {/* Phones only, while the browser offers to install FXM (stage 5.1). */}
      <InstallCard />

      <WelcomeCard />

      <Shelf title="Quick picks" description="Songs picked for you once you start listening.">
        <SongGrid count={9} />
      </Shelf>

      <Shelf title="Your mixes" description="Daily mixes built from the artists you play most.">
        <CardScroller count={10} />
      </Shelf>

      <Shelf title="Recently played" description="Everything you play shows up here.">
        <CardScroller count={10} shape="mixed" />
      </Shelf>
    </div>
  )
}
