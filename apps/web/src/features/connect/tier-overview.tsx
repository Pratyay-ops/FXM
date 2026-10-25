/**
 * The three tiers side by side, with the current one marked, and the "what you're missing" panel
 * for the current tier.
 *
 * @module
 */

import { Check, CircleDashed, Plus } from 'lucide-react'
import { useId } from 'react'
import { cn } from '../../lib/cn'
import type { LiteStatus } from './connection'
import {
  featuresAddedBy,
  LITE_CAVEAT,
  missingFeatures,
  TIER_INFO,
  TIERS,
  type Tier,
  type TierFeature,
} from './tiers'
import { ComingSoonChip, TierName } from './ui'

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
        {!feature.released && (
          <>
            {' '}
            <ComingSoonChip />
          </>
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
              isCurrent ? 'border-accent ring-4 ring-accent/15' : 'border-border',
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-lg font-bold tracking-tight">
                <TierName tier={tier} />
              </h3>
              {isCurrent && (
                <span className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-bold text-on-accent">
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

/** Why Lite isn't on, for the panel of a device in Free only. */
function liteHint(lite: LiteStatus): string | undefined {
  switch (lite) {
    case 'failed':
      return "Its check didn't pass in this browser."
    case 'switched-off':
      return 'It is switched off for everyone at the moment.'
    case 'unavailable':
      return "It isn't available here."
    default:
      return undefined
  }
}

/** What the current tier is missing, grouped by the tier that adds it. */
export function MissingPanel({ tier, lite }: { tier: Tier; lite: LiteStatus }) {
  const headingId = useId()
  const groups = missingFeatures(tier)
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-dashed border-border-strong p-4 sm:p-5"
    >
      <h3 id={headingId} className="font-bold">
        What you're missing
      </h3>
      {groups.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">
          Nothing: this device has everything FXM offers.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {groups.map((group) => {
            const hint = group.tier === 'lite' ? liteHint(lite) : undefined
            return (
              <div key={group.tier} className="space-y-2">
                <p className="text-sm font-semibold">
                  {group.tier === 'lite'
                    ? 'With Lite (experimental), YouTube Music without an install:'
                    : 'With FXM Connect, the desktop app or the Android app:'}
                  {hint !== undefined && (
                    <span className="font-normal text-text-muted"> {hint}</span>
                  )}
                </p>
                <ul className="space-y-2 text-sm">
                  {group.tier === 'full' && (
                    <li className="flex gap-2.5">
                      <Plus aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
                      <span>
                        {tier === 'free'
                          ? 'Everything Lite adds, without depending on its experimental route'
                          : "YouTube Music that doesn't depend on Lite's experimental route"}
                      </span>
                    </li>
                  )}
                  {group.features.map((feature) => (
                    <FeatureItem key={feature.id} feature={feature} />
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
