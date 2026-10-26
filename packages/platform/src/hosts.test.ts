import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  classifyUrl,
  findHostRule,
  HOST_RULES,
  isInnerTubeApiUrl,
  isPlainHttpsUrl,
  matchesHost,
  parseUrl,
  serviceHostRule,
} from './hosts'

function unsupported(run: () => unknown): boolean {
  try {
    run()
  } catch (error) {
    return isFxmError(error, 'Unsupported')
  }
  return false
}

describe('classifyUrl', () => {
  it.each([
    ['https://musicbrainz.org/ws/2/recording?query=creep', 'open'],
    ['https://coverartarchive.org/release/x/front', 'open'],
    ['https://api.listenbrainz.org/1/stats/user/x/artists', 'open'],
    ['https://labs.api.listenbrainz.org/similar-artists/json', 'open'],
    ['https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar', 'open'],
    ['https://lrclib.net/api/get?track_name=Creep', 'open'],
    ['https://archive.org/advancedsearch.php?q=x', 'open'],
    ['https://ia800300.us.archive.org/1/items/x/01.flac', 'open'],
    ['https://api.jamendo.com/v3.0/tracks/?client_id=x', 'open'],
    ['https://prod-1.storage.jamendo.com/download/track/1/flac/', 'open'],
    ['https://itunes.apple.com/search?term=radiohead', 'open'],
    ['https://sponsor.ajay.app/api/skipSegments/abcd', 'open'],
    ['https://i.ytimg.com/vi/x/hqdefault.jpg', 'open'],
    ['https://yt3.ggpht.com/abc=s120', 'open'],
    ['https://lh3.googleusercontent.com/abc=w544-h544-l90-rj', 'open'],
    ['https://yt3.googleusercontent.com/abc=s120-c-k-c0x00ffffff-no-rj', 'open'],
    ['https://i.scdn.co/image/ab67616d0000b273', 'open'],
    ['https://www.youtube.com/youtubei/v1/search', 'innertube'],
    ['https://music.youtube.com/youtubei/v1/browse', 'innertube'],
    ['https://youtubei.googleapis.com/youtubei/v1/player', 'innertube'],
    ['https://www.youtube.com/sw.js_data', 'innertube'],
    ['https://rr1---sn-ab5l6nrz.googlevideo.com/videoplayback?expire=1', 'googlevideo'],
    ['https://open.spotify.com/api/token?reason=init', 'spotify'],
    ['https://api-partner.spotify.com/pathfinder/v2/query', 'spotify'],
    ['https://spclient.wg.spotify.com/metadata/4/track/abc', 'spotify'],
    ['https://www.last.fm/player/station/user/x/library', 'lastfm-web'],
  ])('%s is %s', (url, hostClass) => {
    expect(classifyUrl(url)).toBe(hostClass)
    expect(classifyUrl(new URL(url))).toBe(hostClass)
  })

  it.each([
    ['an unknown host', 'https://example.com/'],
    ['plain HTTP', 'http://musicbrainz.org/ws/2/'],
    ['another port', 'https://musicbrainz.org:8443/ws/2/'],
    ['credentials in the URL', 'https://user:secret@musicbrainz.org/ws/2/'],
    ['the bare domain of a wildcard rule', 'https://googlevideo.com/videoplayback'],
    ['a look-alike domain', 'https://evilgooglevideo.com/videoplayback'],
    ['a domain that only starts like a listed one', 'https://googlevideo.com.evil.example/x'],
    ['an unlisted sub-domain', 'https://m.youtube.com/youtubei/v1/search'],
    ['other Google user content', 'https://doc-0s-docs.googleusercontent.com/docs/x'],
    // Not in the web app's connect-src, which allows yt3.ggpht.com alone.
    ['another ggpht host', 'https://yt4.ggpht.com/abc=s120'],
    ['a Spotify host FXM has no use for', 'https://clienttoken.spotify.com/v1/clienttoken'],
    ['an unlisted parent domain', 'https://youtube.com/youtubei/v1/search'],
    ['a trailing dot', 'https://music.youtube.com./youtubei/v1/search'],
    ['another Last.fm page', 'https://www.last.fm/music/Radiohead'],
    ['a path that climbs out of the station prefix', 'https://www.last.fm/player/station/../../x'],
    ['an IP address', 'https://142.250.0.1/youtubei/v1/search'],
    ['a relative URL', '/youtubei/v1/search'],
    ['a data URL', 'data:text/plain,hello'],
  ])('refuses %s with Unsupported', (_case, url) => {
    expect(unsupported(() => classifyUrl(url))).toBe(true)
  })

  it('names the refused host but never its query string', () => {
    expect(() => classifyUrl('https://example.com/a?token=secret')).toThrow(
      /https:\/\/example\.com\/a: it is not/,
    )
    try {
      classifyUrl('https://example.com/a?token=secret')
    } catch (error) {
      expect(String(error)).not.toContain('secret')
    }
  })
})

describe('the host table', () => {
  it('lists every host the brief names, with the right class', () => {
    const table = Object.fromEntries(HOST_RULES.map((rule) => [rule.host, rule.hostClass]))
    expect(table).toEqual({
      'musicbrainz.org': 'open',
      'coverartarchive.org': 'open',
      'api.listenbrainz.org': 'open',
      'labs.api.listenbrainz.org': 'open',
      'ws.audioscrobbler.com': 'open',
      'lrclib.net': 'open',
      'archive.org': 'open',
      '*.archive.org': 'open',
      'api.jamendo.com': 'open',
      '*.jamendo.com': 'open',
      'itunes.apple.com': 'open',
      'sponsor.ajay.app': 'open',
      'i.ytimg.com': 'open',
      'yt3.ggpht.com': 'open',
      'lh3.googleusercontent.com': 'open',
      'yt3.googleusercontent.com': 'open',
      'i.scdn.co': 'open',
      'www.google.com': 'open',
      'www.youtube.com': 'innertube',
      'music.youtube.com': 'innertube',
      'youtubei.googleapis.com': 'innertube',
      '*.googlevideo.com': 'googlevideo',
      'open.spotify.com': 'spotify',
      'api-partner.spotify.com': 'spotify',
      'spclient.wg.spotify.com': 'spotify',
      'www.last.fm': 'lastfm-web',
    })
  })

  it('never gives one host two classes', () => {
    for (const rule of HOST_RULES) {
      const sample = rule.host.replace('*.', 'sub.')
      const classes = new Set(
        HOST_RULES.filter((other) => matchesHost(sample, other.host)).map((r) => r.hostClass),
      )
      expect(classes, rule.host).toEqual(new Set([rule.hostClass]))
    }
  })

  it('finds no rule for URLs that are not plain HTTPS', () => {
    expect(findHostRule(new URL('wss://music.youtube.com/'))).toBeUndefined()
    expect(isPlainHttpsUrl(new URL('https://music.youtube.com/'))).toBe(true)
    expect(isPlainHttpsUrl(new URL('https://a@music.youtube.com/'))).toBe(false)
  })
})

describe('matchesHost', () => {
  it('matches exact names exactly', () => {
    expect(matchesHost('lrclib.net', 'lrclib.net')).toBe(true)
    expect(matchesHost('www.lrclib.net', 'lrclib.net')).toBe(false)
  })

  it('matches wildcards at any depth, but not the domain itself', () => {
    expect(matchesHost('a.googlevideo.com', '*.googlevideo.com')).toBe(true)
    expect(matchesHost('a.b.googlevideo.com', '*.googlevideo.com')).toBe(true)
    expect(matchesHost('googlevideo.com', '*.googlevideo.com')).toBe(false)
    expect(matchesHost('.googlevideo.com', '*.googlevideo.com')).toBe(false)
    expect(matchesHost('xgooglevideo.com', '*.googlevideo.com')).toBe(false)
  })
})

describe('serviceHostRule', () => {
  it('finds FXM’s own service on a host name, whatever the path or the port would be', () => {
    expect(serviceHostRule('music.youtube.com')?.hostClass).toBe('innertube')
    expect(serviceHostRule('rr1---sn-abc.googlevideo.com')?.hostClass).toBe('googlevideo')
    expect(serviceHostRule(' Open.Spotify.COM ')?.service).toBe('Spotify')
    // Rules with a path prefix count for the whole host.
    expect(serviceHostRule('www.last.fm')?.hostClass).toBe('lastfm-web')
    expect(serviceHostRule('www.google.com')?.service).toBe("Google's BotGuard")
    expect(serviceHostRule('musicbrainz.org')?.hostClass).toBe('open')
  })

  it('finds nothing on other hosts', () => {
    expect(serviceHostRule('api.example.org')).toBeUndefined()
    expect(serviceHostRule('googlevideo.com')).toBeUndefined()
    expect(serviceHostRule('youtube.com.example.org')).toBeUndefined()
  })
})

describe('isInnerTubeApiUrl', () => {
  it('accepts /youtubei/v1/ on the YouTube API hosts only', () => {
    expect(isInnerTubeApiUrl('https://music.youtube.com/youtubei/v1/search')).toBe(true)
    expect(isInnerTubeApiUrl(new URL('https://youtubei.googleapis.com/youtubei/v1/next'))).toBe(
      true,
    )
    expect(isInnerTubeApiUrl('https://www.youtube.com/sw.js_data')).toBe(false)
    expect(isInnerTubeApiUrl('https://www.youtube.com/youtubei/v2/search')).toBe(false)
    expect(isInnerTubeApiUrl('https://example.com/youtubei/v1/search')).toBe(false)
    expect(isInnerTubeApiUrl('not a url')).toBe(false)
  })
})

describe('parseUrl', () => {
  it('parses absolute URLs and refuses the rest with Unsupported', () => {
    expect(parseUrl('https://lrclib.net/api').hostname).toBe('lrclib.net')
    expect(unsupported(() => parseUrl('lrclib.net/api'))).toBe(true)
  })
})
