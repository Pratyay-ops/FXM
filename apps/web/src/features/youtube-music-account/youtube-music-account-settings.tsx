import { hasConnectFeature } from '@fxm/platform'
import { useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { getLibrary } from '../../db/repo'
import { readYouTubeMusicLibrary, useConnection } from '../connect/connection'
import { SettingsSection } from '../settings/settings-layout'
import { runYouTubeMusicSync } from './sync'
import { parseYouTubeMusicSnapshot } from './types'

function count(value: number, noun: string): string {
  return `${value.toLocaleString('en-GB')} ${noun}${value === 1 ? '' : 's'}`
}

/** Settings → YouTube Music account: an explicit, read-only library sync. */
export function YouTubeMusicAccountSettings() {
  const connection = useConnection((state) => state.connect)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const available =
    connection?.state === 'present' && hasConnectFeature(connection, 'youtube-music-login')

  const sync = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const raw = await readYouTubeMusicLibrary()
      const snapshot = parseYouTubeMusicSnapshot(raw)
      const result = await runYouTubeMusicSync(snapshot, getLibrary())
      const parts = [
        count(result.likedAdded, 'liked song added'),
        count(result.songsAdded, 'library song added'),
        count(result.playlistsCreated, 'playlist copied'),
        count(result.playlistTracksAdded, 'playlist track added'),
        count(result.albumsFollowed, 'album saved'),
        count(result.artistsFollowed, 'artist followed'),
      ]
      setMessage(
        `Synced YouTube Music${result.displayName ? ` for ${result.displayName}` : ''}: ${parts.join(', ')}.${result.truncated ? ' Some lists reached the current import limit; run Sync again to continue as limits allow.' : ''}`,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'YouTube Music sync failed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title="YouTube Music account">
      <section className="space-y-4 p-4 sm:p-5" aria-labelledby="youtube-music-account-heading">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1 basis-64 space-y-2">
            <h3 id="youtube-music-account-heading" className="font-semibold">
              Your YouTube Music library
            </h3>
            <div aria-live="polite" className="space-y-2 text-sm text-text-muted">
              <p>
                Copy YouTube Music Liked Songs, your library songs, playlists, saved albums and
                followed artists into FXM. This is a manual, read-only sync: it never changes your
                YouTube Music account, and your FXM edits are kept.
              </p>
              {available ? (
                <p>FXM Connect is ready. Sign in to YouTube Music in this same normal browser profile.</p>
              ) : connection?.state === 'present' ? (
                <p>
                  Open FXM Connect’s options and enable “Use my YouTube Music login from this
                  browser”. The permission is separate from Spotify and off by default.
                </p>
              ) : (
                <p>
                  This needs the current FXM Connect extension. Install or update it, sign in to
                  YouTube Music in the same browser profile, then enable its YouTube Music account
                  option. Private windows and Firefox container tabs are not supported.
                </p>
              )}
              <p>
                <a
                  href="https://music.youtube.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-accent underline-offset-2 hover:underline"
                >
                  Open YouTube Music
                </a>
              </p>
              <p>
                Experimental: FXM uses YouTube Music’s unofficial InnerTube interface through
                youtubei.js. It can change without notice. Account cookies stay inside FXM Connect;
                only music metadata is returned to FXM. Sync is limited to the first 250 library
                items, 30 playlists and 300 tracks per playlist per run.
              </p>
              {message !== '' && <p className="text-text">{message}</p>}
              {error !== '' && <p role="alert" className="font-medium text-danger">{error}</p>}
            </div>
          </div>
          <button
            type="button"
            disabled={!available || busy}
            onClick={() => void sync()}
            className={buttonClasses()}
          >
            {busy ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </section>
    </SettingsSection>
  )
}
