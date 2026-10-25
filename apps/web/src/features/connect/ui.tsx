/**
 * Small pieces the connect feature's pages share: tier and status badges, external links and a
 * browser address with a copy button.
 *
 * @module
 */

import { Check, Clock, Copy, ExternalLink as ExternalLinkIcon, FlaskConical } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { TIER_INFO, type Tier } from './tiers'

/** A small label next to a heading or a list item. */
export function Chip({
  icon,
  children,
  tone = 'neutral',
}: {
  icon?: ReactNode
  children: ReactNode
  tone?: 'neutral' | 'accent'
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 align-middle text-xs font-semibold whitespace-nowrap [&_svg]:size-3.5',
        tone === 'accent'
          ? 'border-accent/40 bg-accent/12 text-text'
          : 'border-border bg-elevated text-text-muted',
      )}
    >
      {icon}
      {children}
    </span>
  )
}

/** "Experimental", for Lite. */
export function ExperimentalChip() {
  return (
    <Chip icon={<FlaskConical aria-hidden="true" />} tone="accent">
      Experimental
    </Chip>
  )
}

/** "Coming soon", for what isn't released yet. */
export function ComingSoonChip() {
  return <Chip icon={<Clock aria-hidden="true" />}>Coming soon</Chip>
}

/** A tier's name, with the experimental marker for Lite. */
export function TierName({ tier }: { tier: Tier }) {
  const info = TIER_INFO[tier]
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{info.name}</span>
      {info.experimental && <ExperimentalChip />}
    </span>
  )
}

/** A link that opens in a new tab, and says so to screen readers. */
export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string
  children: ReactNode
  className?: string
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
      <ExternalLinkIcon aria-hidden="true" className="ml-1 inline size-3.5 align-[-0.125em]" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/** Classes for links in running text. */
export const textLinkClasses =
  'font-semibold text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent'

/**
 * A browser address such as `chrome://extensions`, which pages can't link to, with a button that
 * copies it for the address bar.
 */
export function CopyableAddress({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // No clipboard access: the address is on screen to type.
    }
  }

  return (
    <span className="inline-flex max-w-full items-center gap-1 align-middle">
      <code className="rounded-md bg-elevated px-1.5 py-0.5 font-mono text-[0.8125rem] wrap-anywhere text-text">
        {value}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex size-touch shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-text/8 hover:text-text lg:size-8 lg:pointer-coarse:size-touch [&_svg]:size-4"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span className="sr-only">{copied ? `Copied ${value}` : `Copy ${value}`}</span>
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  )
}
