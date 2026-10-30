import { type ConnectionKind, type NetworkCapabilities, streamingProfile } from '@fxm/core'
import { useId, useMemo } from 'react'
import {
  type AudioReach,
  connectionHelp,
  connectionOptions,
  DATA_SAVER_HELP,
  DATA_SAVER_OVERRIDES,
  IN_USE,
  MOBILE_DATA_HINT,
  QUALITY_TO_USE,
  shownConnection,
  TIER_OPTIONS,
  tierDescription,
} from './quality-options'
import { useQualityStore } from './quality-store'
import { Help, LiveHelp } from './setting-help'
import { SettingSelect } from './setting-select'
import { SettingSwitch } from './setting-switch'
import { SettingRow, SettingsSection } from './settings-layout'
import { useConnection } from './use-connection'
import { browserYouTubeCodecs } from './youtube-codecs'

/** The ids of the elements that describe a control, without those not shown. */
function describedBy(...ids: (string | false)[]): string {
  return ids.filter(Boolean).join(' ')
}

/** The highest tier to stream at on one connection, tagged "In use" while it applies. */
function StreamingTierRow({
  connection,
  label,
  reach,
}: {
  connection: ConnectionKind
  label: string
  reach: AudioReach
}) {
  const prefs = useQualityStore((state) => state.prefs)
  const streaming = useQualityStore((state) => state.streaming)
  const setStreamingTier = useQualityStore((state) => state.setStreamingTier)
  const status = useConnection()
  const labelId = useId()
  const badgeId = useId()
  const helpId = useId()
  const hintId = useId()
  const tier = prefs.streaming[connection]
  const { dataSaver } = streaming
  const inUse =
    !dataSaver && streamingProfile(prefs, streaming, status.detected).connection === connection
  // Where the browser can't tell, mobile data looks like Wi-Fi until the user says otherwise.
  const hint =
    !dataSaver &&
    !status.supported &&
    connection === 'cellular' &&
    streaming.connection !== 'cellular'
  return (
    <SettingRow
      label={label}
      labelId={labelId}
      badge={
        inUse && (
          <span
            id={badgeId}
            className="rounded-full bg-elevated px-2 py-0.5 text-xs font-semibold text-accent forced-colors:border"
          >
            {IN_USE}
          </span>
        )
      }
      help={
        dataSaver ? (
          <Help id={helpId}>{DATA_SAVER_OVERRIDES}</Help>
        ) : (
          <div className="space-y-1">
            <LiveHelp id={helpId}>
              <p>{tierDescription(tier, reach)}</p>
            </LiveHelp>
            {hint && <Help id={hintId}>{MOBILE_DATA_HINT}</Help>}
          </div>
        )
      }
    >
      <SettingSelect
        labelledBy={labelId}
        describedBy={describedBy(helpId, hint && hintId, inUse && badgeId)}
        value={tier}
        options={TIER_OPTIONS}
        onChange={(next) => setStreamingTier(connection, next)}
        disabled={dataSaver}
        className="w-full md:w-auto"
      />
    </SettingRow>
  )
}

/** Which streaming quality applies: the detected connection's where the browser can tell. */
function QualityToUseRow() {
  const streaming = useQualityStore((state) => state.streaming)
  const setConnection = useQualityStore((state) => state.setConnection)
  const status = useConnection()
  const labelId = useId()
  const helpId = useId()
  return (
    <SettingRow
      label={QUALITY_TO_USE}
      labelId={labelId}
      help={
        streaming.dataSaver ? (
          <Help id={helpId}>{DATA_SAVER_OVERRIDES}</Help>
        ) : (
          <LiveHelp id={helpId}>
            <p>{connectionHelp(streaming.connection, status)}</p>
          </LiveHelp>
        )
      }
    >
      <SettingSelect
        labelledBy={labelId}
        describedBy={helpId}
        value={shownConnection(streaming.connection, status)}
        options={connectionOptions(status)}
        onChange={setConnection}
        disabled={streaming.dataSaver}
        className="w-full md:w-auto"
      />
    </SettingRow>
  )
}

function DataSaverRow() {
  const dataSaver = useQualityStore((state) => state.streaming.dataSaver)
  const setDataSaver = useQualityStore((state) => state.setDataSaver)
  const labelId = useId()
  const helpId = useId()
  return (
    <SettingRow
      label="Data saver"
      labelId={labelId}
      help={<Help id={helpId}>{DATA_SAVER_HELP}</Help>}
    >
      <SettingSwitch
        labelledBy={labelId}
        describedBy={helpId}
        checked={dataSaver}
        onChange={setDataSaver}
      />
    </SettingRow>
  )
}

/**
 * The audio quality settings: the data saver first, since it overrides the rows after it; then
 * the highest quality to stream at on Wi-Fi and on mobile data, and which of the two applies.
 * The help follows `capabilities` (what the platform reaches) and the YouTube codecs this
 * browser plays. The stream lifecycle reads the settings from `useQualityStore`. The download
 * format is in the Downloads section (`DownloadsSection`).
 */
export function QualitySection({ capabilities }: { capabilities: NetworkCapabilities }) {
  // The browser's formats never change while the page is open: ask once per mount.
  const codecs = useMemo(() => browserYouTubeCodecs(), [])
  const reach = useMemo<AudioReach>(() => ({ capabilities, codecs }), [capabilities, codecs])
  return (
    <SettingsSection title="Audio quality">
      <DataSaverRow />
      <StreamingTierRow connection="wifi" label="Streaming on Wi-Fi" reach={reach} />
      <StreamingTierRow connection="cellular" label="Streaming on mobile data" reach={reach} />
      <QualityToUseRow />
    </SettingsSection>
  )
}
