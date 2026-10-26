/**
 * The three tiers side by side, with the current one marked, and the "what you're missing" panel
 * for the current tier: a short summary of what the tier cards list in full.
 *
 * @module
 */

import { Check, CircleDashed, Plus } from 'lucide-react'
import { useId } from 'react'
import { cn } from '../../lib/cn'
import {
  featuresAddedBy,
  LITE_CAVEAT,
  missingSummary,
  TIER_INFO,
  TIERS,
  type Tier,
  type TierFeature,
  tierLabel,
} from './tiers'
import { ComingSoonChip, ExperimentalChip, TierName } from './ui'

function FeatureItem({ feature }: { feature: TierFeature }) {
  return (
    <li className={cn('flex gap-2.5', !feature.released && 'text-text-muted')}>
      {feature.released ? (
        <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
      ) : (
        <CircleDashed aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      )}
      <span>
        {feature.label}
        {!feature.released ? (
          <>
            {' '}
            <ComingSoonChip />
          </>
        ) : (
          feature.experimental === true && (
            <>
              {' '}
              <ExperimentalChip />
            </>
          )
        )}
      </span>
    </li>
  )
}

/** The tiers as cards; `current` is marked as this device's. */
export function TierCards({ current, here }: { current: Tier | undefined; here: string }) {
  return (
    <ul className="grid gap-3 lg:grid-cols-3">
      {TIERS.map((tier, index) => {
        const info = TIER_INFO[tier]
        const below = index > 0 ? TIERS[index - 1] : undefined
        const isCurrent = tier === current
        return (
          <li
            key={tier}
            aria-current={isCurrent ? 'true' : undefined}
            className={cn(
              'flex flex-col gap-3 rounded-xl border bg-surface p-4 sm:p-5',
              // Forced colors drop the ring and the accent: a thick system-colour border instead.
              isCurrent
                ? 'border-accent ring-4 ring-accent/15 forced-colors:border-2 forced-colors:border-[color:Highlight]'
                : 'border-border',
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-lg font-bold tracking-tight">
                <TierName tier={tier} />
              </h3>
              {isCurrent && (
                <span className="rounded-full border border-transparent bg-accent px-2.5 py-0.5 text-xs font-bold text-on-accent">
                  {here}
                </span>
              )}
            </div>
            <p className="text-sm text-text-muted">{info.how}</p>
            <ul className="space-y-2 text-sm">
              {below !== undefined && (
                <li className="flex gap-2.5 text-text-muted">
                  <Plus aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>Everything in {TIER_INFO[below].name}</span>
                </li>
              )}
              {featuresAddedBy(tier).map((feature) => (
                <FeatureItem key={feature.id} feature={feature} />
              ))}
            </ul>
            {info.experimental && <p className="mt-auto text-xs text-text-muted">{LITE_CAVEAT}</p>}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * What the current tier is missing, a line per tier above it. It sits under the status card's
 * reasons, which already say why Lite isn't on.
 */
export function MissingPanel({ tier }: { tier: Tier }) {
  const headingId = useId()
  const lines = missingSummary(tier)
  return (
    <section aria-labelledby={headingId} className="space-y-2 border-t border-border pt-4">
      <h3 id={headingId} className="font-bold">
        What you're missing
      </h3>
      {lines.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing: this device has everything FXM offers.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {lines.map((line) => (
            <li key={line.tier} className="flex gap-2.5">
              <Plus aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
              <span>
                <strong>{tierLabel(line.tier)}</strong> adds {line.adds}.
                {line.later !== undefined && <> {line.later}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
