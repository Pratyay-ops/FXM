import type { QueueItem } from '@fxm/core'
import { InfinityIcon } from 'lucide-react'
import { useId } from 'react'
import { canRecommend, useHomeReach, useHomeServices } from '../home/services'
import { Switch } from '../queue/switch'
import { useSourcesSnapshot } from '../search/sources-context'
import { SettingSwitch } from '../settings/setting-switch'
import { SettingRow } from '../settings/settings-layout'
import { isAutoplayItem, useAutoplayMarks } from './autoplay-marks'
import { useAutoplayStore } from './autoplay-store'

/** What autoplay does, for Settings. */
export const AUTOPLAY_HELP =
  'When your queue runs low, FXM adds songs like the ones you just played, so the music keeps going. The songs you like and skip steer what comes next. Songs it adds are marked “Autoplay” in the queue, and you can remove them there.'

/** Why autoplay may not work here, for Settings in the Free tier. */
export const AUTOPLAY_NEEDS_YOUTUBE =
  'It needs YouTube Music, which FXM reaches with FXM Connect, in the desktop and Android apps, or in the experimental Lite tier.'

/** What autoplay does, beside its switch in the queue. */
export const AUTOPLAY_QUEUE_HELP =
  'When your queue runs low, keep going with songs like the ones you just played.'

/**
 * Autoplay in Settings → Playback: the switch, what it does, and, where the platform can't
 * reach YouTube Music, what it needs.
 */
export function AutoplaySetting() {
  const enabled = useAutoplayStore((state) => state.enabled)
  const setEnabled = useAutoplayStore((state) => state.setEnabled)
  const { capabilities } = useSourcesSnapshot()
  const labelId = useId()
  const helpId = useId()
  return (
    <SettingRow
      label="Autoplay"
      labelId={labelId}
      help={
        <div id={helpId} className="space-y-2 text-sm text-text-muted">
          <p>{AUTOPLAY_HELP}</p>
          {capabilities.youtube === 'none' && <p>{AUTOPLAY_NEEDS_YOUTUBE}</p>}
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
 * (`canRecommend`); elsewhere Settings says what it needs.
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

/** The mark of a song autoplay added, under its title in the queue. */
export function AutoplayMark() {
  return (
    <span className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-text-muted">
      <InfinityIcon aria-hidden="true" className="size-3.5 shrink-0" />
      Autoplay
    </span>
  )
}
