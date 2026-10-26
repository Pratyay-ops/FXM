import { describe, expect, it } from 'vitest'
import { runMatch } from '../plan'
import type { MatchOptions } from '../types'
import { answerFromRecording } from './recording'
import { replayMatch } from './replay'
import { item, source } from './testing'
import type { EvalRecording } from './types'

const CREEP = source('Creep', 'Radiohead', 238, {
  album: { name: 'Pablo Honey' },
  isrc: 'GBAYE9200070',
  label: 'XL Recordings',
  releaseDate: '1993-02-22',
})

function recording(): EvalRecording {
  return {
    recordedAt: ['2026-10-26'],
    items: {
      hit: item('Creep', 'Radiohead', 239, { album: 'Pablo Honey', albumId: 'MPREb_ph' }),
      live: item('Creep (Live)', 'Radiohead', 260, { album: 'Live', albumId: 'MPREb_live' }),
      filler: item('Something Else', 'Somebody', 200),
    },
    pages: {
      'isrc-songs/1/GBAYE9200070': { items: ['filler'] },
      'isrc-top-card/GBAYE9200070': { item: null },
      'isrc-songs/2/GBAYE9200070': { items: ['filler'] },
      'songs/Radiohead Creep': { items: ['hit', 'live'] },
      'songs/Radiohead Creep Pablo Honey': { items: ['hit'] },
      'description/hit': { facts: { label: 'XL Recordings', releaseYear: 1993 } },
      'description/live': { facts: {} },
    },
  }
}

describe('replayMatch', () => {
  it('decides as runMatch does with the same pages, live', async () => {
    const pages = recording()
    for (const options of [
      { auto: true },
      { auto: true, requireReleaseAgreement: true },
    ] as MatchOptions[]) {
      const live = await runMatch(
        CREEP,
        async (request) => answerFromRecording(request, pages),
        options,
      )
      const replay = replayMatch(CREEP, pages, options)
      expect(replay.result).toEqual(live)
    }
  })

  it('lists the pages it asked for, and none missing when all were recorded', () => {
    const replay = replayMatch({ ...CREEP, isrc: 'GBAYE9200070' }, recording(), { auto: true })
    expect(replay.requested[0]).toBe('isrc-songs/1/GBAYE9200070')
    expect(replay.requested).toContain('songs/Radiohead Creep')
    expect(replay.unrecorded).toEqual([])
    expect(replay.failed).toEqual([])
    expect(replay.result.incomplete).toBe(false)
    expect(replay.result.isrc.status).toBe('miss')
    expect(replay.result.best?.ref).toBe('hit')
  })

  it('reports a page that was never recorded, and one that failed, as incomplete', () => {
    const pages = recording()
    delete pages.pages['songs/Radiohead Creep']
    pages.pages['isrc-top-card/GBAYE9200070'] = { error: 'Network' }
    const replay = replayMatch(CREEP, pages, { auto: true })
    expect(replay.unrecorded).toEqual(['songs/Radiohead Creep'])
    expect(replay.failed).toEqual(['isrc-top-card/GBAYE9200070'])
    expect(replay.result.incomplete).toBe(true)
  })

  it('shares a replay until the recording gains a page', () => {
    const pages = recording()
    delete pages.pages['songs/Radiohead Creep Pablo Honey']
    const first = replayMatch(CREEP, pages, { auto: true })
    expect(replayMatch(CREEP, pages, { auto: true })).toBe(first)
    pages.pages['songs/Radiohead Creep Pablo Honey'] = { items: ['hit'] }
    const second = replayMatch(CREEP, pages, { auto: true })
    expect(second).not.toBe(first)
    expect(second.unrecorded).toEqual([])
  })
})
