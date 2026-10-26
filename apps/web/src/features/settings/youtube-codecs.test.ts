import { describe, expect, it, vi } from 'vitest'
import { browserYouTubeCodecs, youTubeCodecs } from './youtube-codecs'

const OPUS = 'audio/webm; codecs="opus"'
const AAC = 'audio/mp4; codecs="mp4a.40.2"'

/** A `canPlayType` that answers from a table, '' for any other type. */
const answering =
  (answers: Record<string, CanPlayTypeResult>) =>
  (type: string): CanPlayTypeResult =>
    answers[type] ?? ''

describe('youTubeCodecs', () => {
  it('asks for the MIME types the player’s engine asks for', () => {
    const asked: string[] = []
    youTubeCodecs((type) => {
      asked.push(type)
      return ''
    })
    expect(asked).toEqual([OPUS, AAC])
  })

  it.each<[string, Record<string, CanPlayTypeResult>, string[]]>([
    [
      'both, where the browser is sure of both',
      { [OPUS]: 'probably', [AAC]: 'probably' },
      ['opus', 'aac'],
    ],
    ['AAC only, where Opus only may play', { [OPUS]: 'maybe', [AAC]: 'probably' }, ['aac']],
    ['AAC only, where Opus doesn’t play', { [AAC]: 'probably' }, ['aac']],
    ['Opus only, where AAC only may play', { [OPUS]: 'probably', [AAC]: 'maybe' }, ['opus']],
    [
      'those that may play, where it is sure of none',
      { [OPUS]: 'maybe', [AAC]: 'maybe' },
      ['opus', 'aac'],
    ],
    ['none, where neither plays', {}, []],
  ])('chooses %s', (_label, answers, expected) => {
    expect(youTubeCodecs(answering(answers))).toEqual(expected)
  })

  it('asks an audio element of this browser', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(
      answering({ [AAC]: 'probably', [OPUS]: 'maybe' }),
    )
    expect(browserYouTubeCodecs()).toEqual(['aac'])
  })
})
