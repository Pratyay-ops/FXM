/**
 * How downloads read in the UI: sizes, progress, states and errors.
 *
 * @module
 */

import { CODEC_LABELS } from '@fxm/core'
import type { DownloadErrorCode, DownloadFileFormat, DownloadRecord } from '@fxm/downloads'

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const

/** A size for people, in decimal units as the operating systems show them: "4.2 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 bytes'
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  if (unit === 0) return `${Math.round(value)} ${value === 1 ? 'byte' : 'bytes'}`
  const digits = value < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${UNITS[unit]}`
}

/** How far a download got, from 0 to 1, or `undefined` while its size is unknown. */
export function progressOf(
  record: Pick<DownloadRecord, 'bytesDone' | 'bytesTotal'>,
): number | undefined {
  const { bytesDone, bytesTotal } = record
  if (bytesTotal === undefined || bytesTotal <= 0) return undefined
  return Math.min(1, Math.max(0, bytesDone / bytesTotal))
}

/** "2.1 MB of 4.3 MB", or "2.1 MB" while the size is unknown. */
export function bytesLabel(record: Pick<DownloadRecord, 'bytesDone' | 'bytesTotal'>): string {
  const done = formatBytes(record.bytesDone)
  return record.bytesTotal === undefined ? done : `${done} of ${formatBytes(record.bytesTotal)}`
}

/** What each error says to the user. */
export const ERROR_TEXT: Readonly<Record<DownloadErrorCode, string>> = {
  unsupported: 'Downloading it needs FXM Connect, the desktop app or the Android app',
  unavailable: "This song can't be played right now",
  'needs-review': "FXM isn't sure it found the right version. Check the match, then try again",
  unverified: "Couldn't get the whole file. Try again later",
  network: 'The connection kept dropping',
  server: 'The server kept refusing. Try again later',
  'storage-full': 'There is no room left for downloads',
  storage: "This browser window can't store downloads. Private windows often can't",
  'bot-check': 'YouTube asked for a check that FXM can’t pass. Try again later',
  'file-missing': 'The downloaded file is gone. Download it again',
  unknown: 'Something went wrong',
}

/** One line about a download that is on its way: "Waiting", "Paused · 1.2 MB of 4.3 MB", … */
export function statusLine(record: DownloadRecord, online: boolean): string {
  switch (record.status) {
    case 'queued':
      return online ? 'Waiting' : 'Waiting for a connection'
    case 'downloading':
      if (!online) return `Waiting for a connection · ${bytesLabel(record)}`
      return record.bytesDone === 0 ? 'Starting' : bytesLabel(record)
    case 'paused':
      return record.bytesDone === 0 ? 'Paused' : `Paused · ${bytesLabel(record)}`
    case 'failed':
      return ERROR_TEXT[record.error?.code ?? 'unknown']
    case 'completed':
      return record.bytesTotal === undefined ? 'Downloaded' : formatBytes(record.bytesTotal)
    case 'removing':
      return 'Removing'
  }
}

/**
 * What a downloaded file is, honestly: "Opus · 150 kbps", "AAC from 360p video". The original
 * bytes are kept (converting them is stage 4.2), so this is the source's own format.
 */
export function formatLabel(format: DownloadFileFormat): string {
  const codec = CODEC_LABELS[format.codec]
  if (format.media === 'muxed-video') return `${codec} from 360p video`
  const rate = format.bitrateKbps === undefined ? '' : ` · ${Math.round(format.bitrateKbps)} kbps`
  return `${codec}${rate}`
}
