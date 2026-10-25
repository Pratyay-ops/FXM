import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import type { CatalogMode } from '../mode'
import type { Track } from '../model'
import data from './__fixtures__/golden.json'
import { matchTrack } from './engine'
import type {
  AutoBlocker,
  IsrcOrigin,
  IsrcStatus,
  MatchBand,
  MatchOptions,
  MatchPages,
  MatchResult,
  MatchSource,
  ReleaseFacts,
  VideoSongMatch,
} from './types'
import { matchVideoToSong } from './video'

/** One search result as the fixture stores it. */
interface GoldenItem {
  id: string
  source?: string
  kind: string
  title: string
  artists: string[]
  album?: string
  albumId?: string
  durationMs?: number
  explicit?: boolean
  songId?: string
}

/** A page: a shared page's key, a shared page cut to its top items, or the items themselves. */
type PageRef = string | { page: string; top: number } | GoldenItem[]

type Label = 'exact' | 'equivalent' | 'wrong' | 'unknown'

/** How a case's inputs were made, when not recorded as they are (see `about` in the file). */
type Constructed = 'page' | 'items' | 'facts'

interface GoldenCase {
  id: string
  category: string
  constructed?: Constructed
  mainstream?: boolean
  description: string
  provenance: string
  source?: {
    title: string
    artists: Array<{ name: string }>
    album?: { name: string }
    durationMs?: number
    isrc?: string
    isrcOrigin?: IsrcOrigin
    explicit?: boolean
    label?: string
    releaseDate?: string
  }
  options?: { mode?: CatalogMode; requireReleaseAgreement?: boolean }
  pages?: {
    isrcSongs?: PageRef[]
    isrcTopCard?: GoldenItem | null
    text?: PageRef
    album?: PageRef
    videos?: PageRef
    youtube?: PageRef
    releaseFacts?: Record<string, ReleaseFacts>
  }
  video?: GoldenItem
  songs?: PageRef
  labels: Record<string, Label>
  expect: {
    band: MatchBand
    pick?: string
    isrc?: IsrcStatus
    blockers?: AutoBlocker[]
    via?: VideoSongMatch['via']
  }
}

interface GoldenFile {
  about: string[]
  pages: Record<string, { provenance: string; query: string | null; items: GoldenItem[] }>
  cases: GoldenCase[]
}

const golden = data as unknown as GoldenFile

function toTrack(item: GoldenItem): Track {
  const source = item.source === 'yt' ? 'yt' : 'ytm'
  const track: Track = {
    id: formatId(source, 'track', item.id),
    source,
    title: item.title,
    artists: item.artists.map((name) => ({ name })),
    artwork: [],
    kind: item.kind as Track['kind'],
  }
  if (item.album !== undefined) {
    track.album = { name: item.album }
    if (item.albumId !== undefined) track.album.id = formatId(source, 'album', item.albumId)
  }
  if (item.durationMs !== undefined) track.durationMs = item.durationMs
  if (item.explicit !== undefined) track.explicit = item.explicit
  if (item.songId !== undefined) track.songId = formatId('ytm', 'track', item.songId)
  return track
}

function resolve(ref: PageRef): Track[] {
  if (Array.isArray(ref)) return ref.map(toTrack)
  const key = typeof ref === 'string' ? ref : ref.page
  const page = golden.pages[key]
  if (page === undefined) throw new Error(`no page ${key}`)
  const items = typeof ref === 'string' ? page.items : page.items.slice(0, ref.top)
  return items.map(toTrack)
}

function pagesOf(c: GoldenCase): MatchPages {
  const pages: MatchPages = {}
  const given = c.pages ?? {}
  if (given.isrcSongs !== undefined) pages.isrcSongs = given.isrcSongs.map(resolve)
  if (given.isrcTopCard !== undefined) {
    pages.isrcTopCard = given.isrcTopCard === null ? null : toTrack(given.isrcTopCard)
  }
  if (given.text !== undefined) pages.text = resolve(given.text)
  if (given.album !== undefined) pages.album = resolve(given.album)
  if (given.videos !== undefined) pages.videos = resolve(given.videos)
  if (given.youtube !== undefined) pages.youtube = resolve(given.youtube)
  if (given.releaseFacts !== undefined) {
    pages.releaseFacts = Object.fromEntries(
      Object.entries(given.releaseFacts).map(([id, facts]) => [
        formatId('ytm', 'track', id),
        facts,
      ]),
    )
  }
  return pages
}

function sourceOf(c: GoldenCase): MatchSource {
  if (c.source === undefined) throw new Error(`${c.id} has no source`)
  return c.source
}

const trackCases = golden.cases.filter((c) => c.video === undefined)
const videoCases = golden.cases.filter((c) => c.video !== undefined)

function run(c: GoldenCase, extra: MatchOptions = {}): MatchResult {
  return matchTrack(sourceOf(c), pagesOf(c), { auto: true, ...c.options, ...extra })
}

function runVideo(c: GoldenCase, extra: MatchOptions = {}): VideoSongMatch {
  if (c.video === undefined) throw new Error(`${c.id} has no video`)
  return matchVideoToSong(toTrack(c.video), resolve(c.songs ?? []), { auto: true, ...extra })
}

/** The label of the candidate a result picked. */
function labelOf(c: GoldenCase, ref: string | undefined): Label {
  return ref === undefined ? 'unknown' : (c.labels[ref] ?? 'unknown')
}

const RIGHT = new Set<Label>(['exact', 'equivalent'])

describe('the golden dataset', () => {
  it('has at least 60 cases, each with an expectation and a provenance', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(60)
    for (const c of golden.cases) {
      expect(c.provenance, c.id).not.toBe('')
      expect(['auto', 'suggest', 'none'], c.id).toContain(c.expect.band)
    }
    expect(new Set(golden.cases.map((c) => c.id)).size).toBe(golden.cases.length)
  })

  it.each(['replay', 'isrc-squatter', 'isrc-miss', 'spotify-singles', 'filler', 'classical'])(
    'covers the %s category',
    (category) => {
      expect(golden.cases.some((c) => c.category === category)).toBe(true)
    },
  )
})

describe.each(trackCases.map((c) => [c.id, c] as const))('golden track %s', (_id, c) => {
  const result = run(c)

  it('ends in the expected band', () => {
    expect(result.band, result.evidence.join('; ')).toBe(c.expect.band)
  })

  if (c.expect.pick !== undefined) {
    it('picks the expected candidate', () => {
      expect(result.best?.ref).toBe(c.expect.pick)
    })
  }

  if (c.expect.isrc !== undefined) {
    it('reaches the expected ISRC verdict', () => {
      expect(result.isrc.status).toBe(c.expect.isrc)
    })
  }

  if (c.expect.blockers !== undefined) {
    it('names the guard that blocked Auto', () => {
      for (const blocker of c.expect.blockers ?? []) expect(result.autoBlockers).toContain(blocker)
    })
  }

  it('never auto-plays a wrong or unproven recording', () => {
    if (result.band === 'auto') expect(RIGHT.has(labelOf(c, result.best?.ref))).toBe(true)
  })

  it('lets only the right recording pass the ISRC gate', () => {
    if (result.isrc.status === 'verified') {
      const ref = result.isrc.trackId?.split(':').at(-1)
      expect(labelOf(c, ref)).toBe('exact')
    }
  })

  it('never reaches Auto with the setting off, with the same verdict', () => {
    const off = run(c, { auto: false })
    expect(off.band).not.toBe('auto')
    expect(off.best?.ref).toBe(result.best?.ref)
    expect(off.autoEligible).toBe(result.autoEligible)
    expect(off.best?.verdict).toEqual(result.best?.verdict)
  })
})

describe.each(videoCases.map((c) => [c.id, c] as const))('golden video %s', (_id, c) => {
  const result = runVideo(c)

  it('maps as expected', () => {
    expect(result.band, result.evidence.join('; ')).toBe(c.expect.band)
    if (c.expect.via !== undefined) expect(result.via).toBe(c.expect.via)
    const picked = result.songId?.split(':').at(-1)
    if (c.expect.pick !== undefined) expect(picked).toBe(c.expect.pick)
  })

  it('never auto-maps to a wrong or unproven song', () => {
    if (result.via === 'match' && result.band === 'auto') {
      expect(RIGHT.has(labelOf(c, result.songId?.split(':').at(-1)))).toBe(true)
    }
  })

  it('is a suggestion only while the Auto setting is off, unless the video links its song', () => {
    const off = runVideo(c, { auto: false })
    expect(off.band).toBe(result.via === 'link' || result.band !== 'auto' ? result.band : 'suggest')
    expect(off.autoEligible).toBe(result.autoEligible)
  })
})

describe('the golden totals', () => {
  const results = trackCases.map((c) => ({ c, result: run(c) }))

  it('has zero wrong Auto plays', () => {
    const wrong = results.filter(
      ({ c, result }) => result.band === 'auto' && !RIGHT.has(labelOf(c, result.best?.ref)),
    )
    expect(wrong.map(({ c }) => c.id)).toEqual([])
  })

  it('auto-plays at least 85 % of the mainstream cases, recorded ones alone too', () => {
    const mainstream = results.filter(({ c }) => c.mainstream)
    const recorded = mainstream.filter(({ c }) => c.constructed === undefined)
    for (const set of [mainstream, recorded]) {
      const auto = set.filter(({ result }) => result.band === 'auto')
      expect(set.length).toBeGreaterThanOrEqual(20)
      expect(auto.length / set.length).toBeGreaterThanOrEqual(0.85)
    }
  })

  it('rests every done-when total on recorded cases, not only constructed ones', () => {
    const counts = (category: (c: GoldenCase) => boolean) => {
      const cases = golden.cases.filter(category)
      const constructed = cases.filter((c) => c.constructed !== undefined).length
      return { recorded: cases.length - constructed, constructed }
    }
    expect(counts((c) => c.category === 'replay').recorded).toBeGreaterThanOrEqual(3)
    expect(
      counts((c) => ['isrc-squatter', 'filler'].includes(c.category)).recorded,
    ).toBeGreaterThanOrEqual(4)
    expect(counts((c) => c.category === 'isrc-miss').recorded).toBeGreaterThanOrEqual(5)
    expect(counts((c) => c.category === 'classical').recorded).toBeGreaterThanOrEqual(2)
    expect(counts((c) => c.video !== undefined).recorded).toBeGreaterThanOrEqual(10)
    for (const c of golden.cases) {
      if (c.constructed !== undefined)
        expect(['page', 'items', 'facts'], c.id).toContain(c.constructed)
      // A made-up item is always marked: x- IDs only in cases that say they are constructed.
      if (JSON.stringify(c).includes('"x-')) expect(c.constructed, c.id).toBeDefined()
    }
  })

  it('ends every held-out replay in Suggest or on the right recording', () => {
    const replays = results.filter(({ c }) => c.category === 'replay')
    expect(replays.length).toBeGreaterThanOrEqual(3)
    for (const { c, result } of replays) {
      const right = result.band !== 'auto' || labelOf(c, result.best?.ref) === 'exact'
      expect(right, c.id).toBe(true)
      expect(result.isrc.status, c.id).toBe('not-run')
    }
  })

  it('never lets a squatter, cover or same-artist filler pass the ISRC gate', () => {
    for (const { c, result } of results) {
      if (result.isrc.status !== 'verified') continue
      const ref = result.isrc.trackId?.split(':').at(-1)
      expect(labelOf(c, ref), c.id).toBe('exact')
    }
    const guarded = results.filter(({ c }) => ['isrc-squatter', 'filler'].includes(c.category))
    expect(guarded.length).toBeGreaterThanOrEqual(4)
    for (const { c, result } of guarded) expect(result.isrc.status, c.id).toBe('miss')
  })
})
