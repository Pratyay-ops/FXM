import {
  type ConnectionKind,
  DEFAULT_MP3_KBPS,
  isMp3Bitrate,
  type Mp3Bitrate,
  streamingProfile,
} from '@fxm/core'
import { type ReactNode, useId } from 'react'
import { SegmentedControl } from '../../components/ui/segmented-control'
import {
  connectionHelp,
  connectionOptions,
  DATA_SAVER_HELP,
  DATA_SAVER_OPTIONS,
  DATA_SAVER_OVERRIDES,
  DOWNLOAD_FORMAT_OPTIONS,
  downloadFormatHelp,
  MP3_BITRATE_HELP,
  MP3_BITRATE_OPTIONS,
  type Mp3BitrateValue,
  shownConnection,
  TIER_DESCRIPTIONS,
  TIER_OPTIONS,
} from './quality-options'
import { useQualityStore } from './quality-store'
import { SettingSelect } from './setting-select'
import { SettingRow, SettingsSection } from './settings-layout'
import { useConnection } from './use-connection'

/** A setting's help text, announced when it changes with the value. */
function Help({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} aria-live="polite" className="space-y-1 text-sm text-text-muted">
      {children}
    </div>
  )
}

/** The highest tier to stream at on one connection. */
function StreamingTierRow({ connection, label }: { connection: ConnectionKind; label: string }) {
  const tier = useQualityStore((state) => state.prefs.streaming[connection])
  const dataSaver = useQualityStore((state) => state.streaming.dataSaver)
  const setStreamingTier = useQualityStore((state) => state.setStreamingTier)
  const labelId = useId()
  const helpId = useId()
  return (
    <SettingRow
      label={label}
      labelId={labelId}
      help={
        <Help id={helpId}>
          <p>{dataSaver ? DATA_SAVER_OVERRIDES : TIER_DESCRIPTIONS[tier]}</p>
        </Help>
      }
    >
      <SettingSelect
        labelledBy={labelId}
        describedBy={helpId}
        value={tier}
        options={TIER_OPTIONS}
        onChange={(next) => setStreamingTier(connection, next)}
        disabled={dataSaver}
        className="w-full md:w-auto"
      />
    </SettingRow>
  )
}

/** Which connection's quality applies: detected where the browser can tell, else the user's. */
function ConnectionRow() {
  const prefs = useQualityStore((state) => state.prefs)
  const streaming = useQualityStore((state) => state.streaming)
  const setConnection = useQualityStore((state) => state.setConnection)
  const status = useConnection()
  const profile = streamingProfile(prefs, streaming, status.detected)
  const labelId = useId()
  const helpId = useId()
  return (
    <SettingRow
      label="Connection"
      labelId={labelId}
      help={
        <Help id={helpId}>
          <p>{connectionHelp(streaming, status, profile)}</p>
        </Help>
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
      help={
        <p id={helpId} className="text-sm text-text-muted">
          {DATA_SAVER_HELP}
        </p>
      }
    >
      <SegmentedControl
        label="Data saver"
        labelledBy={labelId}
        describedBy={helpId}
        value={dataSaver ? 'on' : 'off'}
        options={DATA_SAVER_OPTIONS}
        onChange={(value) => setDataSaver(value === 'on')}
        className="w-full md:w-auto"
      />
    </SettingRow>
  )
}

function DownloadFormatRow() {
  const format = useQualityStore((state) => state.prefs.download.format)
  const setDownloadFormat = useQualityStore((state) => state.setDownloadFormat)
  const labelId = useId()
  const helpId = useId()
  return (
    <SettingRow
      label="Download format"
      labelId={labelId}
      help={
        <Help id={helpId}>
          {downloadFormatHelp(format).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Help>
      }
    >
      <SettingSelect
        labelledBy={labelId}
        describedBy={helpId}
        value={format}
        options={DOWNLOAD_FORMAT_OPTIONS}
        onChange={setDownloadFormat}
        className="w-full md:w-auto"
      />
    </SettingRow>
  )
}

function Mp3BitrateRow() {
  const kbps: Mp3Bitrate = useQualityStore(
    (state) => state.prefs.download.mp3Kbps ?? DEFAULT_MP3_KBPS,
  )
  const setMp3Bitrate = useQualityStore((state) => state.setMp3Bitrate)
  const labelId = useId()
  const helpId = useId()
  return (
    <SettingRow
      label="MP3 bitrate"
      labelId={labelId}
      help={
        <p id={helpId} className="text-sm text-text-muted">
          {MP3_BITRATE_HELP}
        </p>
      }
    >
      <SettingSelect<Mp3BitrateValue>
        labelledBy={labelId}
        describedBy={helpId}
        value={`${kbps}`}
        options={MP3_BITRATE_OPTIONS}
        onChange={(value) => {
          const next = Number(value)
          if (isMp3Bitrate(next)) setMp3Bitrate(next)
        }}
        className="w-full md:w-auto"
      />
    </SettingRow>
  )
}

/**
 * The audio quality settings: the highest quality to stream at on Wi-Fi and on mobile data,
 * which of the two applies, the data saver, and the format and MP3 bitrate downloads are saved
 * in. The stream lifecycle and the download manager read them from `useQualityStore`.
 */
export function QualitySection() {
  const format = useQualityStore((state) => state.prefs.download.format)
  return (
    <SettingsSection title="Audio quality">
      <StreamingTierRow connection="wifi" label="Streaming on Wi-Fi" />
      <StreamingTierRow connection="cellular" label="Streaming on mobile data" />
      <ConnectionRow />
      <DataSaverRow />
      <DownloadFormatRow />
      {format === 'mp3' && <Mp3BitrateRow />}
    </SettingsSection>
  )
}
