/**
 * Settings → FXM Connect: a lasting way to the onboarding page (`/connect`) in a browser, also
 * once the first-visit notice is dismissed. Its words don't depend on the tier, so the row never
 * changes size when detection finishes.
 *
 * @module
 */

import { ChevronRight, PlugZap } from 'lucide-react'
import { useId } from 'react'
import { Link } from 'react-router'
import { useConnection } from './connection'

export function ConnectSettingsEntry() {
  const web = useConnection((state) => state.platform === 'web')
  const headingId = useId()
  if (!web) return null
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="px-1 text-lg font-bold tracking-tight">
        FXM Connect
      </h2>
      <Link
        to="/connect"
        className="flex items-center gap-4 rounded-xl border border-border bg-surface p-4 transition-colors hover:bg-elevated sm:p-5"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
          <PlugZap aria-hidden="true" className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Tiers and install guides</span>
          <span className="block text-sm text-text-muted">
            What this browser plays, what each tier adds, and the install guides.
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-text-muted" />
      </Link>
    </section>
  )
}
