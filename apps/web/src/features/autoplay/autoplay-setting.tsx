import type { QueueItem } from '@fxm/core'
import { InfinityIcon } from 'lucide-react'
import { useId, useMemo } from 'react'
import { Link } from 'react-router'
import { cn } from '../../lib/cn'
import { currentDevice, type DeviceInfo } from '../connect/device'
import { reachSentence } from '../connect/explain'
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

/**
 * Why autoplay adds nothing here, for Settings in the Free tier: it needs YouTube Music, and how
 * this device reaches it (`reachSentence`): FXM Connect where its browser can add it, the apps
 * once they are out, else what works here instead. It never offers what this device can't get.
 */
export function autoplayNeedsYouTube(device: DeviceInfo = currentDevice()): string {
  return `Autoplay needs YouTube Music. ${reachSentence('YouTube Music', device)}`
}

/** What autoplay does, beside its switch in the queue. */
export const AUTOPLAY_QUEUE_HELP =
  'When your queue runs low, keep going with songs like the ones you just played.'

/** What the queue says while autoplay finds songs to add. */
export const AUTOPLAY_FINDING = 'Finding songs like the ones you just played…'

/**
 * Why autoplay can't add songs here, if it can't: the platform can't reach YouTube Music
 * (`needs-youtube`). Nothing while the tier is still being worked out, so the note doesn't come
 * and go: while FXM Connect answers (the registry's `detecting`) and, in the app, until the
 * first Lite self-test ended (Home's sources say `detecting` until then). Nothing either before
 * the recommendation sources are wired in, which the app does once the platform is ready.
 */
export function autoplayNote(
  services: HomeServices,
  reach: HomeSourcesSnapshot,
  detecting: boolean,
): 'needs-youtube' | undefined {
  if (canRecommend(services, reach) || services.recommendations === undefined) return undefined
  return detecting || reach.detecting === true ? undefined : 'needs-youtube'
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
  const device = useMemo(currentDevice, [])
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
            {note === 'needs-youtube' && <p>{autoplayNeedsYouTube(device)}</p>}
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
