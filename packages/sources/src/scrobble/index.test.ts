import { describe, expect, it } from 'vitest'
import * as scrobble from './index'

describe('@fxm/sources/scrobble', () => {
  it('exports the clients, the queue and the rules', () => {
    expect(Object.keys(scrobble).sort()).toEqual(
      [
        'LASTFM_API_ACCOUNT_URL',
        'LASTFM_API_URL',
        'LASTFM_APPLICATIONS_URL',
        'LASTFM_AUTHORIZE_URL',
        'LASTFM_BATCH_SIZE',
        'LASTFM_ERRORS',
        'LASTFM_RULES',
        'LISTENBRAINZ_API_URL',
        'LISTENBRAINZ_BATCH_SIZE',
        'LISTENBRAINZ_RULES',
        'LISTENBRAINZ_SETTINGS_URL',
        'LastfmScrobbleClient',
        'ListenBrainzScrobbleClient',
        'MAX_QUEUED_SCROBBLES',
        'MAX_REJECTIONS_IN_A_ROW',
        'SCROBBLE_LISTEN_CAP_MS',
        'SCROBBLE_SERVICES',
        'SCROBBLE_SERVICE_NAMES',
        'ScrobbleError',
        'Scrobbler',
        'createMemoryScrobbleStore',
        'isLastfmKey',
        'isListenBrainzToken',
        'lastfmFailureOf',
        'lastfmSignature',
        'lastfmTarget',
        'listenBrainzTarget',
        'listenOf',
        'qualifiesForScrobble',
        'sanitizeScrobble',
        'scrobbleFailureOf',
        'scrobbleOf',
        'scrobbleThresholdMs',
        'scrobbleTrackOf',
      ].sort(),
    )
  })

  it('names the services in the order the app lists them', () => {
    expect(scrobble.SCROBBLE_SERVICES).toEqual(['listenbrainz', 'lastfm'])
    expect(scrobble.SCROBBLE_SERVICE_NAMES).toEqual({
      listenbrainz: 'ListenBrainz',
      lastfm: 'Last.fm',
    })
  })

  it('talks to the services over HTTPS only', () => {
    for (const url of [
      scrobble.LASTFM_API_URL,
      scrobble.LASTFM_AUTHORIZE_URL,
      scrobble.LASTFM_API_ACCOUNT_URL,
      scrobble.LASTFM_APPLICATIONS_URL,
      scrobble.LISTENBRAINZ_API_URL,
      scrobble.LISTENBRAINZ_SETTINGS_URL,
    ]) {
      expect(new URL(url).protocol).toBe('https:')
    }
  })
})
