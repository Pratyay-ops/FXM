import {
  DEFAULT_MP3_KBPS,
  isMp3Bitrate,
  type Mp3Bitrate,
  type NetworkCapabilities,
} from '@fxm/core'
import { useId } from 'react'
import { RELEASED } from '../connect/config'
import { useConnection } from '../connect/connection'
import { useSaveDestination } from '../downloads/save/device'
import {
  CONVERSIONS_COMING,
  type DownloadFormatUse,
  downloadFormatHelp,
  downloadFormatNote,
  effectiveDownloadFormat,
  MP3_BITRATE_HELP,
  MP3_BITRATE_OPTIONS,
  type Mp3BitrateValue,
  offeredDownloadFormats,
  SAVE_FILE_LABEL,
  saveFileHelp,
} from './quality-options'
import { useQualityStore } from './quality-store'
import { Help, LiveHelp } from './setting-help'
import { SettingSelect } from './setting-select'
import { SettingSwitch } from './setting-switch'
import { SettingRow, SettingsSection } from './settings-layout'

/** Whether Download saves a file too, with what that means where saved files go here. */
function SaveFileRow() {
  const saveFile = useQualityStore((state) => state.downloads.saveFile)
  const setSaveFile = useQualityStore((state) => state.setSaveFile)
  const destination = useSaveDestination()
  const platform = useConnection((state) => state.platform)
  const labelId = useId()
  const helpId = useId()
  const unavailable = destination === 'none'
  return (
    <SettingRow
      label={SAVE_FILE_LABEL}
      labelId={labelId}
      help={
        unavailable ? (
          <Help id={helpId}>{saveFileHelp(saveFile, destination, platform)}</Help>
        ) : (
          <LiveHelp id={helpId}>
            <p>{saveFileHelp(saveFile, destination, platform)}</p>
          </LiveHelp>
        )
      }
    >
      <SettingSwitch
        labelledBy={labelId}
        describedBy={helpId}
        checked={saveFile && !unavailable}
        disabled={unavailable}
        onChange={setSaveFile}
      />
    </SettingRow>
  )
}

function DownloadFormatRow({
  capabilities,
  conversions,
  use,
}: {
  capabilities: NetworkCapabilities
  conversions: boolean
  use: DownloadFormatUse
}) {
  const stored = useQualityStore((state) => state.prefs.download.format)
  const format = effectiveDownloadFormat(stored, conversions)
  const setDownloadFormat = useQualityStore((state) => state.setDownloadFormat)
  const labelId = useId()
  const helpId = useId()
  const noteId = useId()
  return (
    <SettingRow
      label="Download format"
      labelId={labelId}
      help={
        <div className="space-y-1">
          <LiveHelp id={helpId}>
            {downloadFormatHelp(format, capabilities).map((line) => (
              <p key={line}>{line}</p>
            ))}
            {!conversions && <p>{CONVERSIONS_COMING}</p>}
          </LiveHelp>
          {/* The save-file setting changes it: not announced (see LiveHelp). */}
          <Help id={noteId}>{downloadFormatNote(use)}</Help>
        </div>
      }
    >
      <SettingSelect
        labelledBy={labelId}
        describedBy={`${helpId} ${noteId}`}
        value={format}
        options={offeredDownloadFormats(conversions)}
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
      help={<Help id={helpId}>{MP3_BITRATE_HELP}</Help>}
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
 * The download settings: whether Download also saves a file to the device (on by default; off,
 * it keeps the copy in FXM only, and "Save to device…" saves a file later), and the format and
 * MP3 bitrate the Download dialog and "Save to device…" start at. A download itself always keeps
 * the original file, which plays offline. The help follows `capabilities` (what the platform
 * reaches) and where saved files go here (`useSaveDestination`); the Download dialog reads the
 * settings from `useQualityStore`.
 */
export function DownloadsSection({
  capabilities,
  conversions = RELEASED.conversions,
}: {
  capabilities: NetworkCapabilities
  /** Whether saving converts (stage 4.2). Default: `RELEASED.conversions`. */
  conversions?: boolean
}) {
  const stored = useQualityStore((state) => state.prefs.download.format)
  const saveFile = useQualityStore((state) => state.downloads.saveFile)
  const destination = useSaveDestination()
  const format = effectiveDownloadFormat(stored, conversions)
  const use: DownloadFormatUse =
    destination === 'none' ? 'none' : saveFile ? 'download' : 'save-later'
  return (
    <SettingsSection title="Downloads">
      <SaveFileRow />
      <DownloadFormatRow capabilities={capabilities} conversions={conversions} use={use} />
      {format === 'mp3' && <Mp3BitrateRow />}
    </SettingsSection>
  )
}
