/**
 * YouTube Music's `next` responses: the queue of a video, or of a radio (`RDAMVM<videoId>`,
 * an artist's `RDEM…`), and its continuation pages.
 *
 * @module
 */

import { FxmError, type Track } from '@fxm/core'
import { arrayAt, at, recordAt, stringAt } from '../json'
import { type MapOptions, mapPanelVideo } from './items'
import { continuationOf } from './lists'

/** One page of a queue. */
export interface QueuePage {
  /** The queue's tracks, in order. Automix previews and unplayable items are left out. */
  readonly tracks: Track[]
  /** The continuation token of the next page, if the queue goes on. */
  readonly continuation?: string
  /** The playlist or radio the queue plays, e.g. `RDAMVM…`. */
  readonly playlistId?: string
}

function queuePage(panel: unknown, options: MapOptions): QueuePage {
  const contents = arrayAt(panel, 'contents')
  const tracks = contents.flatMap((item) => {
    const track = mapPanelVideo(item, options)
    return track === undefined ? [] : [track]
  })
  const continuation = continuationOf(contents, panel)
  const playlistId = stringAt(panel, 'playlistId')
  return {
    tracks,
    ...(continuation === undefined ? {} : { continuation }),
    ...(playlistId === undefined ? {} : { playlistId }),
  }
}

/**
 * Reads the first page of a `next` response. A queue without content, YouTube's answer to an
 * unknown video, is an empty page.
 *
 * @throws FxmError `Parse` when the response has no watch-next contents at all.
 */
export function parseQueue(json: unknown, options: MapOptions): QueuePage {
  const tabs = arrayAt(
    json,
    'contents',
    'singleColumnMusicWatchNextResultsRenderer',
    'tabbedRenderer',
    'watchNextTabbedResultsRenderer',
    'tabs',
  )
  if (tabs.length === 0) throw new FxmError('Parse', 'The next response has no queue')
  const panel = at(
    tabs[0],
    'tabRenderer',
    'content',
    'musicQueueRenderer',
    'content',
    'playlistPanelRenderer',
  )
  return queuePage(panel, options)
}

/**
 * Reads a continuation page of a queue (`playlistPanelContinuation`).
 *
 * @throws FxmError `Parse` when the response is not one.
 */
export function parseQueueContinuation(json: unknown, options: MapOptions): QueuePage {
  const panel = recordAt(json, 'continuationContents', 'playlistPanelContinuation')
  if (panel === undefined) throw new FxmError('Parse', 'The next continuation has no queue')
  return queuePage(panel, options)
}
