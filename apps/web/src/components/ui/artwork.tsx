import { type LucideIcon, Music } from 'lucide-react'
import { cn } from '../../lib/cn'
import { seedGradient } from '../../lib/seed'

const RADII = { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', xl: 'rounded-xl' } as const

export interface ArtworkProps {
  /** Any stable string (an id): the same seed always gets the same colors. */
  seed: string
  shape?: 'square' | 'circle' | undefined
  /** Corner radius of square artwork. */
  rounded?: keyof typeof RADII | undefined
  icon?: LucideIcon | undefined
  /** Size, shadow and layout classes (not border radius: use `rounded`). */
  className?: string | undefined
}

/** Placeholder cover art: a gradient picked from the seed, with a centered icon. */
export function Artwork({
  seed,
  shape = 'square',
  rounded = 'md',
  icon: Icon = Music,
  className,
}: ArtworkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden',
        shape === 'circle' ? 'rounded-full' : RADII[rounded],
        className,
      )}
      style={{ backgroundImage: seedGradient(seed) }}
    >
      <Icon className="size-[38%] text-white/85" strokeWidth={1.5} />
    </span>
  )
}
