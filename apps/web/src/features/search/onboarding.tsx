import { Plug } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { appsReachSentence } from '../connect/explain'

/**
 * Where the onboarding entry point leads: the in-app onboarding of stage 2.7 (`/connect`), with
 * the tiers, what this device can add and the install guides. A route of the app, so the link
 * stays in the app.
 */
export const ONBOARDING_URL = '/connect'

/** The onboarding entry point, as a button-styled link. */
export function OnboardingLink({
  children = 'Get FXM Connect',
  variant = 'primary',
}: {
  children?: ReactNode
  variant?: 'primary' | 'secondary'
}) {
  return (
    <Link to={ONBOARDING_URL} className={buttonClasses({ variant })}>
      {children}
    </Link>
  )
}

/**
 * The onboarding entry point in brief: a banner for the empty search page while `name` (YouTube
 * Music) can't be reached, so the user learns before searching rather than after.
 */
export function OnboardingBanner({ name }: { name: string }) {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="flex flex-1 items-start gap-3">
        <Plug aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-text-muted" />
        <div className="space-y-0.5">
          <h2 id={headingId} className="text-sm font-semibold">
            Search needs {name} access
          </h2>
          <p className="text-sm text-text-muted">{appsReachSentence(name)}</p>
        </div>
      </div>
      <div className="pl-8 sm:pl-0">
        <OnboardingLink />
      </div>
    </section>
  )
}
