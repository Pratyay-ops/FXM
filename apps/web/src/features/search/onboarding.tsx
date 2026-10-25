import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { buttonClasses } from '../../components/ui/button'

/**
 * Where the onboarding entry point leads: how to get FXM Connect, the desktop app or the
 * Android app. Until stage 2.7 builds the in-app onboarding (tiers and install guides), it is
 * the landing page's "Get FXM" section; 2.7 points it at its own page.
 */
export const ONBOARDING_URL = 'https://fxm-music.pages.dev/#get'

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
