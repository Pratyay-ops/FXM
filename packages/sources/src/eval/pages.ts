/**
 * Fetches the pages the matching planner asks for, through the YouTube providers of stage 1.3,
 * and files them in a group's recording in the labelled set's format (`matchingEval` in
 * `@fxm/core`). One page key is one provider call, so one InnerTube request (plus `sw.js_data`
 * once per session in the full tier).
 *
 * The mapping from a planner request to a provider call is the one a live `AudioSource.match`
 * needs too: a songs search for the ISRC and text searches, the unfiltered search's top-result
 * card, and a video's description for its release facts.
 *
 * @module
 */

import { formatId, matchingEval, type ProviderContext, parseReleaseDescription } from '@fxm/core'
import type { YouTubeMusicProvider, YouTubeVideoProvider } from '../youtube'

type EvalPage = matchingEval.EvalPage
type EvalRecording = matchingEval.EvalRecording

/** The provider calls the recorder makes. */
export interface PageProviders {
  /** YouTube Music: songs searches, the top-result card and descriptions. */
  readonly music: Pick<YouTubeMusicProvider, 'search' | 'topResult' | 'getDescription'>
  /** Plain YouTube, for the `youtube` searches of Music + Video mode. */
  readonly video?: Pick<YouTubeVideoProvider, 'search'>
}

/**
 * Fetches the page `key` names (see `matchingEval.pageKeys`) and files it in `recording`: the
 * items of a search, the track of a top-result card (`null` when the card is not a track), or a
 * description's release facts and the lines YouTube generated for a label upload.
 *
 * @returns The page as filed.
 * @throws The provider's `FxmError`; nothing is filed then.
 * @throws RangeError for a key that names no page.
 */
export async function fetchPage(
  key: string,
  providers: PageProviders,
  ctx: ProviderContext,
  recording: EvalRecording,
): Promise<EvalPage> {
  const parts = matchingEval.parsePageKey(key)
  if (parts === undefined) throw new RangeError(`Not a page key: ${key}`)
  let page: EvalPage
  switch (parts.kind) {
    case 'isrc-songs':
    case 'songs': {
      const results = await providers.music.search(parts.query, { types: ['track'] }, ctx)
      page = { items: matchingEval.fileItems(recording, results.tracks?.items ?? []) }
      break
    }
    case 'videos': {
      const results = await providers.music.search(parts.query, { types: ['video'] }, ctx)
      page = { items: matchingEval.fileItems(recording, results.videos?.items ?? []) }
      break
    }
    case 'youtube': {
      if (providers.video === undefined) throw new RangeError('No YouTube video provider')
      const results = await providers.video.search(parts.query, { types: ['video'] }, ctx)
      page = { items: matchingEval.fileItems(recording, results.videos?.items ?? []) }
      break
    }
    case 'isrc-top-card': {
      const top = await providers.music.topResult(parts.query, ctx)
      const [item] = top?.type === 'track' ? matchingEval.fileItems(recording, [top.track]) : []
      page = { item: item ?? null }
      break
    }
    case 'description': {
      const text = await providers.music.getDescription(
        formatId('ytm', 'track', parts.videoId),
        ctx,
      )
      const excerpt = matchingEval.descriptionExcerpt(text)
      page = {
        facts: parseReleaseDescription(text ?? ''),
        ...(excerpt === undefined ? {} : { excerpt }),
      }
      break
    }
  }
  recording.pages[key] = page
  return page
}
