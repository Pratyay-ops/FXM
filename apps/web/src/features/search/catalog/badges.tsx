import type { SourceId } from '@fxm/core'
import { cn } from '../../../lib/cn'
import { sourceLabel } from '../sources'

/**
 * A small label on a row: what the item is (`kind`, filled) or where it comes from (`source`,
 * outlined). Text in FXM's own colors only: no service logos or brand colors (docs/LEGAL.md).
 */
export function Badge({ variant, children }: { variant: 'kind' | 'source'; children: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 text-2xs leading-none font-semibold whitespace-nowrap',
        variant === 'kind'
          ? 'bg-elevated text-text forced-colors:border'
          : 'border border-border-strong/70 text-text-muted',
      )}
    >
      {children}
    </span>
  )
}

/** The kind badge: `Song`, `Official video`, `Album`, `Artist` … */
export function KindBadge({ label }: { label: string }) {
  return <Badge variant="kind">{label}</Badge>
}

/** The source badge: `YouTube Music`, `Spotify` … */
export function SourceBadge({ source }: { source: SourceId }) {
  return <Badge variant="source">{sourceLabel(source)}</Badge>
}

/** Both badges, kind first. */
export function ItemBadges({
  kind,
  source,
  explicit = false,
  className,
}: {
  kind: string
  source: SourceId
  explicit?: boolean | undefined
  className?: string | undefined
}) {
  return (
    <span className={cn('flex shrink-0 items-center gap-1', className)}>
      <KindBadge label={kind} />
      <SourceBadge source={source} />
      {explicit && <ExplicitBadge />}
    </span>
  )
}

/** The "E" for explicit tracks and albums. */
export function ExplicitBadge() {
  return (
    <span
      role="img"
      aria-label="Explicit"
      title="Explicit"
      className="inline-grid size-4 shrink-0 place-items-center rounded-xs bg-text-muted text-[0.625rem] leading-none font-bold text-background forced-colors:border"
    >
      E
    </span>
  )
}
