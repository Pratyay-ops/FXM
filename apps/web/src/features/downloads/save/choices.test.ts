import { describe, expect, it } from 'vitest'
import { track } from '../../../test/library-fixtures'
import { plannedChoiceHelp, plannedChoices, sourceKinds } from './choices'
import { plannedSaveRequest, savedMessage } from './job'

const archive = { ...track(2), source: 'archive' as const }
const free = { and: 'Internet Archive', or: 'Internet Archive', several: false }

describe('the formats before a download', () => {
  it('are the formats themselves, each with its extension but the original', () => {
    expect(plannedChoices(true).map(({ label, extension }) => [label, extension])).toEqual([
      ['Original', undefined],
      ['FLAC', 'flac'],
      ['ALAC', 'm4a'],
      ['WAV', 'wav'],
      ['MP3', 'mp3'],
      ['AAC', 'm4a'],
      ['Opus', 'opus'],
    ])
    expect(plannedChoices(false).map((choice) => choice.format)).toEqual(['original'])
  })

  it('say what each gives for the songs’ sources, never calling YouTube audio lossless', () => {
    const youtube = sourceKinds([track(1)])
    expect(youtube).toEqual({ youtube: true, free: false })
    expect(
      plannedChoiceHelp('alac', youtube, { several: false, youtubeCodec: 'opus', free }),
    ).toEqual([
      'A YouTube song in Opus: ALAC (converted from Opus, same quality as the source).',
      'YouTube audio is never lossless: converting it gives a bigger file, not a better one.',
      'Where a song isn’t in this format already, FXM converts it on this device once it is downloaded, which takes a little while.',
    ])
    // Where the browser downloads YouTube's AAC (it can't play Opus).
    expect(
      plannedChoiceHelp('aac', youtube, { several: false, youtubeCodec: 'aac', free })[0],
    ).toBe('A YouTube song in AAC: AAC (no conversion).')
    expect(plannedChoiceHelp('original', youtube, { several: false, free })).toEqual([
      'The file as YouTube has it, Opus or AAC, with no conversion and no quality loss.',
    ])
  })

  it('cover the free sources, and a mix of both', () => {
    const kinds = sourceKinds([archive])
    expect(kinds).toEqual({ youtube: false, free: true })
    expect(plannedChoiceHelp('mp3', kinds, { several: true, mp3Kbps: 192, free })).toEqual([
      'A lossless source in FLAC: MP3 (converted from FLAC, some quality loss).',
      'An MP3 from Internet Archive: MP3 (no conversion).',
      'MP3 files are encoded at 192 kbps.',
      'Where a song isn’t in this format already, FXM converts it on this device once it is downloaded, which takes a little while.',
    ])
    expect(plannedChoiceHelp('flac', kinds, { several: true, free })).toContain(
      'Lossy audio never becomes lossless: converting it gives a bigger file, not a better one.',
    )
    expect(
      plannedChoiceHelp('original', sourceKinds([track(1), archive]), { several: true, free }),
    ).toEqual([
      'Each file as its source has it, with no conversion and no quality loss: Opus or AAC for YouTube songs, FLAC where a source is lossless.',
    ])
  })
})

describe('the file a download will save', () => {
  it('is known before the download for every format but the original', () => {
    expect(plannedSaveRequest(track(1), 'flac')).toEqual({
      fileName: 'Artist 1 - Song 1.flac',
      mimeType: 'audio/flac',
      description: 'FLAC audio',
    })
    expect(plannedSaveRequest(track(1), 'opus')).toEqual({
      fileName: 'Artist 1 - Song 1.opus',
      mimeType: 'audio/ogg',
      description: 'Opus audio',
    })
    expect(plannedSaveRequest(track(1), 'original')).toBeUndefined()
  })

  it('is confirmed in words that say where it went', () => {
    const saved = (n: number, tagged = true) => ({
      saved: Array.from({ length: n }, (_, index) => ({
        track: track(index + 1),
        fileName: `Artist ${index + 1} - Song ${index + 1}.mp3`,
        tagged,
      })),
      failed: [],
      downloaded: [],
    })
    expect(savedMessage(saved(1), {})).toBe('Saved “Song 1” as Artist 1 - Song 1.mp3')
    expect(savedMessage(saved(1, false), {})).toBe(
      'Saved “Song 1” as Artist 1 - Song 1.mp3, without its tags',
    )
    expect(savedMessage(saved(3), { folder: 'Music' })).toBe('Saved 3 songs to “Music”')
    expect(savedMessage(saved(2), { downloads: true })).toBe(
      'Saved 2 songs to your browser’s downloads',
    )
    expect(savedMessage(saved(2), {})).toBe('Saved 2 songs')
  })
})
