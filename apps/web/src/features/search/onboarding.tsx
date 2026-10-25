import { ExternalLink, Plug } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { buttonClasses } from '../../components/ui/button'

/**
 * Where the onboarding entry point leads: how to get FXM Connect, the desktop app or the
 * Android app. Until stage 2.7 builds the in-app onboarding (tiers and install guides), it is
 * the landing page's "Get FXM" section; 2.7 points it at its own page.
 */
export const ONBOARDING_URL = 'https://fxmusic.pages.dev/#get'

/** The onboarding entry point, as a button-styled link. */
export function OnboardingLink({
  children = 'Get FXM Connect',
  variant = 'primary',
}: {
  children?: ReactNode
  variant?: 'primary' | 'secondary'
}) {
  return (
    <a
      href={ONBOARDING_URL}
      target="_blank"
      rel="noreferrer"
      className={buttonClasses({ variant })}
    >
      {children}
      <ExternalLink aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
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
          <p className="text-sm text-text-muted">
            FXM reaches {name} through the free FXM Connect browser extension, or through the
            desktop and Android apps.
          </p>
        </div>
      </div>
      <div className="pl-8 sm:pl-0">
        <OnboardingLink />
      </div>
    </section>
  )
}
