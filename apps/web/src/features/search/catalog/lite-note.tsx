import { FlaskConical } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { ONBOARDING_URL } from '../onboarding'

/**
 * Explains the Lite tier where it matters: on YouTube items, which have no downloads and no
 * equalizer there. Search shows it above YouTube results, and album, artist and playlist pages
 * under their actions, where those entries are missing from the menus.
 */
export function LiteNote({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-start gap-2 text-sm text-text-muted', className)}>
      <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        Lite mode, experimental: YouTube Music without an install, but no downloads or equalizer.{' '}
        <a
          href={ONBOARDING_URL}
          target="_blank"
          rel="noreferrer"
          className="font-semibold whitespace-nowrap text-text underline underline-offset-2"
        >
          Get FXM Connect
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </span>
    </p>
  )
}
