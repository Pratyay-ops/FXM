import { hasConnectFeature } from '@fxm/platform'
import { AlertCircle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { getAppServices } from '../../app/services'
import { buttonClasses } from '../../components/ui/button'
import { getLibrary } from '../../db/repo'
import { SettingsSection } from '../settings/settings-layout'
import {
  forgetYouTubeMusicSyncHistory,
  parseYouTubeMusicSnapshot,
  runYouTubeMusicSync,
} from './sync'

const OPTIONS_HINT =
  "Open FXM Connect's options from its button in the browser toolbar and enable YouTube Music account access."

/**
 * A manual, one-shot YouTube Music library import. FXM Connect performs the authenticated read;
 * the page receives normalized metadata only. Credentials never enter the app or library.
 */
export function YouTubeMusicAccountSettings() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)

  const forget = async () => {
    setBusy(true)
    setError(false)
    try {
      const forgotten = await forgetYouTubeMusicSyncHistory(getLibrary())
      setMessage(
        forgotten
          ? 'Sync history forgotten. Your imported playlists and follows remain in your FXM library.'
          : 'There is no YouTube Music sync history to forget.',
      )
    } catch {
      setMessage('FXM could not forget the YouTube Music sync history.')
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const sync = async () => {
    setBusy(true)
    setMessage('Checking FXM Connect and reading your YouTube Music library…')
    setError(false)
    try {
      const app = getAppServices()
      const platform = await app.start()
      const connect = platform?.connect
      if (connect === undefined) {
        throw new Error('FXM Connect is available only in the FXM web app in a supported browser.')
      }
      const status = await connect.detect()
      if (!hasConnectFeature(status, 'youtube-music-login')) {
        throw new Error(`YouTube Music account access is not enabled. ${OPTIONS_HINT}`)
      }
      const response = await connect.youtubeMusicLibrary()
      if (response.status !== 200) {
        throw new Error(
          response.status === 401 || response.status === 403
            ? 'YouTube Music did not accept the browser session. Sign in to music.youtube.com and try again.'
            : `YouTube Music could not be read (HTTP ${response.status}). Try again later.`,
        )
      }
      const snapshot = parseYouTubeMusicSnapshot(response.json)
      if (snapshot === undefined) {
        throw new Error(
          'YouTube Music returned a library FXM could not safely read. No local items were changed.',
        )
      }
      const result = await runYouTubeMusicSync(getLibrary(), snapshot)
      setMessage(
        `Synced ${result.likedSongs.toLocaleString('en-GB')} liked songs and ${result.playlists.toLocaleString('en-GB')} playlists, ${result.savedAlbums.toLocaleString('en-GB')} albums and ${result.followedArtists.toLocaleString('en-GB')} artists. Added ${result.addedTracks.toLocaleString('en-GB')} tracks and ${result.addedFollows.toLocaleString('en-GB')} follows.`,
      )
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : 'FXM could not sync YouTube Music just now.'
      setMessage(message)
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title="YouTube Music account">
      <div className="space-y-3 p-4 sm:p-5">
        <p className="text-sm text-text-muted">
          Manually copy Liked Music, your playlists, saved albums and followed artists into this
          device's FXM library. FXM never changes your YouTube Music account.
        </p>
        <p className="text-sm text-text-muted">
          First enable "Use my YouTube Music login from this browser" in FXM Connect's options.
          The extension requests the optional browser cookies permission; credentials remain inside
          the extension and only normalized music metadata reaches FXM.
        </p>
        <p className="text-sm text-text-muted">
          This uses YouTube Music's unofficial internal interface and is experimental. It can
          break when YouTube changes that interface. Sync is manual; no background account polling
          is performed. To revoke account access, turn off the YouTube Music option in FXM Connect.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void sync()}
            className={buttonClasses({ variant: 'primary' })}
          >
            <RefreshCw aria-hidden="true" className={busy ? 'size-4 animate-spin' : 'size-4'} />
            {busy ? 'Syncing…' : 'Sync YouTube Music now'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void forget()}
            className="inline-flex items-center rounded-md px-3 py-2 text-sm font-semibold text-text-muted hover:bg-surface-2 disabled:opacity-50"
          >
            Forget sync history
          </button>
          <a
            href="https://music.youtube.com/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-semibold text-accent underline-offset-2 hover:underline"
          >
            Open YouTube Music
            <ExternalLink aria-hidden="true" className="size-3.5" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
        {message && (
          <p
            role="status"
            aria-live="polite"
            className={error ? 'flex items-start gap-2 text-sm text-danger' : 'flex items-start gap-2 text-sm text-text-muted'}
          >
            {error ? (
              <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            ) : (
              <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            )}
            {message}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}
