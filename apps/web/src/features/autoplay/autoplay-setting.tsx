import type { QueueItem } from '@fxm/core'
import { InfinityIcon } from 'lucide-react'
import { useId } from 'react'
import { Link } from 'react-router'
import { cn } from '../../lib/cn'
import { standaloneLinkClasses } from '../connect/ui'
import {
  canRecommend,
  type HomeServices,
  type HomeSourcesSnapshot,
  useHomeReach,
  useHomeServices,
} from '../home/services'
import { Switch } from '../queue/switch'
import { useSourcesSnapshot } from '../search/sources-context'
import { SettingSwitch } from '../settings/setting-switch'
import { SettingRow } from '../settings/settings-layout'
import { isFindingSongs, useAutoplayActivity } from './autoplay-activity'
import { isAutoplayItem, useAutoplayMarks } from './autoplay-marks'
import { useAutoplayStore } from './autoplay-store'

/** What autoplay does, for Settings. */
export const AUTOPLAY_HELP =
  'When your queue runs low, FXM adds songs like the ones you just played, so the music keeps going. The songs you like and skip steer what comes next. Songs it adds are marked “Autoplay” in the queue, and you can remove them there. Switching it off also takes out the ones that haven’t played yet, unless you moved them.'

/** Why autoplay adds nothing here, for Settings in the Free tier. */
export const AUTOPLAY_NEEDS_YOUTUBE =
  'Autoplay needs YouTube Music. FXM reaches it with the free FXM Connect extension, the desktop and Android apps, or the experimental Lite tier.'

/** Why autoplay adds nothing, for Settings in a build without the recommendation sources. */
export const AUTOPLAY_NOT_YET =
  'This version of FXM can’t find songs to add yet. That comes in a later update.'

/** What autoplay does, beside its switch in the queue. */
export const AUTOPLAY_QUEUE_HELP =
  'When your queue runs low, keep going with songs like the ones you just played.'

/** What the queue says while autoplay finds songs to add. */
export const AUTOPLAY_FINDING = 'Finding songs like the ones you just played…'

/**
 * Why autoplay can't add songs here, if it can't: this build has no recommendation sources
 * (`not-yet`), or the platform can't reach YouTube Music (`needs-youtube`). Nothing while FXM
 * Connect is still answering (`detecting`), so the note doesn't come and go as the tier is
 * worked out.
 */
export function autoplayNote(
  services: HomeServices,
  reach: HomeSourcesSnapshot,
  detecting: boolean,
): 'not-yet' | 'needs-youtube' | undefined {
  if (canRecommend(services, reach)) return undefined
  if (services.recommendations === undefined) return 'not-yet'
  return detecting ? undefined : 'needs-youtube'
}

/**
 * Autoplay in Settings → Playback: the switch, what it does, and why it adds nothing where it
 * can't run (as the queue's switch, which shows only where it can).
 */
export function AutoplaySetting() {
  const enabled = useAutoplayStore((state) => state.enabled)
  const setEnabled = useAutoplayStore((state) => state.setEnabled)
  const services = useHomeServices()
  const reach = useHomeReach(services)
  const { detecting = false } = useSourcesSnapshot()
  const note = autoplayNote(services, reach, detecting)
  const labelId = useId()
  const helpId = useId()
  return (
    <SettingRow
      label="Autoplay"
      labelId={labelId}
      help={
        <div className="space-y-2 text-sm text-text-muted">
          <div id={helpId} className="space-y-2">
            <p>{AUTOPLAY_HELP}</p>
            {note === 'not-yet' && <p>{AUTOPLAY_NOT_YET}</p>}
            {note === 'needs-youtube' && <p>{AUTOPLAY_NEEDS_YOUTUBE}</p>}
          </div>
          {note === 'needs-youtube' && (
            <p>
              <Link to="/connect" className={standaloneLinkClasses}>
                Tiers and install guides
              </Link>
            </p>
          )}
        </div>
      }
    >
      <SettingSwitch
        labelledBy={labelId}
        describedBy={helpId}
        checked={enabled}
        onChange={setEnabled}
      />
    </SettingRow>
  )
}

/**
 * The autoplay switch in the queue, where the songs it adds show. Only where autoplay can run
 * (`canRecommend`); elsewhere Settings says why it can't.
 */
export function AutoplaySwitch({ className }: { className?: string }) {
  const enabled = useAutoplayStore((state) => state.enabled)
  const setEnabled = useAutoplayStore((state) => state.setEnabled)
  const services = useHomeServices()
  const reach = useHomeReach(services)
  if (!canRecommend(services, reach)) return null
  return (
    <Switch
      label="Autoplay"
      description={AUTOPLAY_QUEUE_HELP}
      checked={enabled}
      onChange={setEnabled}
      {...(className === undefined ? {} : { className })}
    />
  )
}

/** Whether autoplay added `item` to the queue; re-renders when that changes. */
export function useIsAutoplayItem(item: Pick<QueueItem, 'uid' | 'track'>): boolean {
  return useAutoplayMarks((state) => isAutoplayItem(state.marks, item))
}

/** Whether autoplay is finding songs to add (`autoplay-activity.ts`); re-renders when it changes. */
export function useAutoplayFinding(): boolean {
  return useAutoplayActivity(isFindingSongs)
}

/** The mark of a song autoplay added, under its title in the queue. */
export function AutoplayMark() {
  return (
    <span className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-text-muted">
      <InfinityIcon aria-hidden="true" className="size-3.5 shrink-0" />
      Autoplay
    </span>
  )
}

/** "Finding songs like the ones you just played…", in the queue while autoplay finds them. */
export function AutoplayFinding({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-center gap-2 text-sm text-text-muted', className)}>
      <InfinityIcon aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-pulse" />
      {AUTOPLAY_FINDING}
    </p>
  )
}
