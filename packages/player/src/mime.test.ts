import type { Codec, Container } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { mimeTypeOf } from './mime'

describe('mimeTypeOf', () => {
  it.each([
    ['opus', 'webm', 'audio/webm; codecs="opus"'],
    ['vorbis', 'webm', 'audio/webm; codecs="vorbis"'],
    ['aac', 'mp4', 'audio/mp4; codecs="mp4a.40.2"'],
    ['aac', 'm4a', 'audio/mp4; codecs="mp4a.40.2"'],
    ['alac', 'm4a', 'audio/mp4; codecs="alac"'],
    ['flac', 'mp4', 'audio/mp4; codecs="flac"'],
    ['opus', 'mp4', 'audio/mp4; codecs="opus"'],
    ['opus', 'ogg', 'audio/ogg; codecs="opus"'],
    ['vorbis', 'ogg', 'audio/ogg; codecs="vorbis"'],
    ['flac', 'ogg', 'audio/ogg; codecs="flac"'],
    ['mp3', 'mp3', 'audio/mpeg'],
    ['flac', 'flac', 'audio/flac'],
    ['pcm', 'wav', 'audio/wav'],
  ] as const)('labels %s in %s as %s', (codec, container, type) => {
    expect(mimeTypeOf({ codec, container })).toBe(type)
  })

  it.each([
    ['aac', 'webm'],
    ['mp3', 'mp4'],
    ['opus', 'flac'],
    ['toString', 'webm'],
    ['opus', 'toString'],
  ])('has no type for %s in %s', (codec, container) => {
    expect(mimeTypeOf({ codec: codec as Codec, container: container as Container })).toBeUndefined()
  })
})
