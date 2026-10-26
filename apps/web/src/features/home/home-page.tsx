import { lazy, Suspense } from 'react'
import { PageWash } from '../../components/media/collection-header'
import { InstallCard } from '../pwa/install-card'
import { HomeSkeleton } from './home-skeleton'

/** Everything below the greeting, which needs the library and the engine: a lazy chunk. */
const HomeContent = lazy(() =>
  import('./home-content').then((module) => ({ default: module.HomeContent })),
)

/** "Good morning" before noon, "Good afternoon" until 6 pm, "Good evening" otherwise. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function HomePage() {
  const greeting = greetingFor(new Date().getHours())
  return (
    <div className="space-y-10 md:space-y-12">
      <PageWash color="color-mix(in oklab, var(--color-accent) 24%, transparent)" />
      <h1 className="pt-4 text-display font-extrabold md:pt-6">{greeting}</h1>

      {/* Phones only, while the browser offers to install FXM (stage 5.1). */}
      <InstallCard />

      <Suspense fallback={<HomeSkeleton />}>
        <HomeContent />
      </Suspense>
    </div>
  )
}
