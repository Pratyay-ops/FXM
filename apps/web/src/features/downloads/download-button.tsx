import type { Track } from '@fxm/core'
import type { DownloadRecord } from '@fxm/downloads'
import { ArrowDownToLine, CircleAlert, CircleCheck, CirclePause, Clock3 } from 'lucide-react'
import { useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { IconButton, type IconButtonSize } from '../../components/ui/icon-button'
import { Dialog, DialogActions } from '../library/ui/dialog'
import { pauseDownload, removeDownloads, requestDownload, resumeDownload } from './actions'
import { progressOf } from './format'
import { useDownload, useDownloadAvailability } from './hooks'
import { ProgressRing } from './progress'

export interface DownloadButtonProps {
  track: Track
  size?: Exclude<IconButtonSize, 'custom' | 'lg'>
  className?: string
}

/** The label, icon and action of the button for a download in each state. */
function stateOf(track: Track, record: DownloadRecord) {
  const title = track.title
  switch (record.status) {
    case 'queued':
      return {
        label: `Waiting to download ${title}. Pause`,
        icon: <Clock3 />,
        act: () => pauseDownload(record.id),
      }
    case 'downloading': {
      const value = progressOf(record)
      const percent = value === undefined ? '' : `, ${Math.round(value * 100)}%`
      return {
        label: `Downloading ${title}${percent}. Pause`,
        icon: <ProgressRing value={value} className="text-accent" />,
        act: () => pauseDownload(record.id),
      }
    }
    case 'paused':
      return {
        label: `Download of ${title} paused. Resume`,
        icon: <CirclePause />,
        act: () => resumeDownload(record.id),
      }
    case 'failed':
      return {
        label: `Download of ${title} failed. Try again`,
        icon: <CircleAlert className="text-danger" />,
        act: () => resumeDownload(record.id),
      }
    default:
      return undefined
  }
}

/**
 * Downloads a track (through the Download dialog, which also saves a file, unless Settings says
 * to keep an offline copy only), and then shows how its download goes: waiting, a ring that
 * fills, paused, failed or downloaded. A click pauses, resumes or retries it; on a downloaded track it offers
 * to remove the download. It renders nothing where the track can't be downloaded (YouTube audio
 * without FXM Connect, the desktop app or the Android app, the Lite tier included) unless the
 * track is downloaded already, so that download can still be removed.
 */
export function DownloadButton({ track, size = 'sm', className }: DownloadButtonProps) {
  const availability = useDownloadAvailability(track)
  const record = useDownload(track)
  const [confirming, setConfirming] = useState(false)

  // Nothing until the database answers, so a downloaded song never flashes "Download".
  if (record === undefined) return null
  if (record === null) {
    if (availability?.available !== true) return null
    return (
      <IconButton
        label={`Download ${track.title}`}
        icon={<ArrowDownToLine />}
        size={size}
        className={className}
        onClick={() => requestDownload([track])}
      />
    )
  }

  if (record.status === 'completed') {
    return (
      <>
        <IconButton
          label={`Remove the download of ${track.title}`}
          icon={<CircleCheck />}
          size={size}
          active
          className={className}
          onClick={() => setConfirming(true)}
        />
        <RemoveDownloadDialog
          open={confirming}
          title={track.title}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            void removeDownloads([track])
          }}
        />
      </>
    )
  }

  const state = stateOf(track, record)
  if (state === undefined) return null
  return (
    <IconButton
      label={state.label}
      icon={state.icon}
      size={size}
      className={className}
      onClick={() => void state.act()}
    />
  )
}

/** Asks before a download is deleted: the song won't play offline any more. */
export function RemoveDownloadDialog({
  open,
  title,
  count = 1,
  onClose,
  onConfirm,
}: {
  open: boolean
  /** The song's title, when it is one song. */
  title?: string | undefined
  count?: number
  onClose: () => void
  onConfirm: () => void
}) {
  const one = count === 1
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={one ? 'Remove download?' : `Remove ${count} downloads?`}
      description={
        one && title !== undefined
          ? `“${title}” won’t play offline any more. You can download it again.`
          : 'These songs won’t play offline any more. You can download them again.'
      }
    >
      <DialogActions>
        <button type="button" className={buttonClasses({ variant: 'ghost' })} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          data-autofocus=""
          className={buttonClasses({ variant: 'danger' })}
          onClick={onConfirm}
        >
          {one ? 'Remove download' : 'Remove downloads'}
        </button>
      </DialogActions>
    </Dialog>
  )
}
