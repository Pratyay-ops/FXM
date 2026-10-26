import { FlaskConical } from 'lucide-react'
import { Link } from 'react-router'
import { cn } from '../../../lib/cn'
import { getMoreLabel } from '../../connect/explain'
import { ONBOARDING_URL } from '../onboarding'
import { useSourcesSnapshot } from '../sources-context'

/**
 * Explains the Lite tier where it matters: on YouTube items, whose songs can't be downloaded
 * there (their bytes are unreadable). Search shows it above YouTube results, and album, artist
 * and playlist pages under their actions, where the Download entries are missing from the menus.
 *
 * Not while FXM Connect is still answering (the sources say `detecting`): where Lite's check
 * passes before FXM Connect's service worker wakes up, the tier is Lite for a moment, but the
 * note's pitch for FXM Connect would most likely be wrong.
 */
export function LiteNote({ className }: { className?: string }) {
  const { detecting = false } = useSourcesSnapshot()
  if (detecting) return null
  return (
    <p className={cn('flex items-start gap-2 text-sm text-text-muted', className)}>
      <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        Lite tier, experimental: YouTube Music without an install, but its songs can't be downloaded
        here.{' '}
        <Link
          to={ONBOARDING_URL}
          className="font-semibold whitespace-nowrap text-text underline underline-offset-2"
        >
          {getMoreLabel()}
        </Link>
      </span>
    </p>
  )
}
