/**
 * The recorded answers the composition root's Vitest tests serve through the fake network:
 * the providers' own sanitized fixtures (see their READMEs), read from their packages so there
 * is one copy of each.
 *
 * @module
 */

import ninGhosts from '../../../../../../packages/sources/src/archive/fixtures/item-nin-ghosts.json'
import archiveSearch from '../../../../../../packages/sources/src/archive/fixtures/search-nin-ghosts.json'
import acrLookup from '../../../../../../packages/sources/src/listenbrainz/fixtures/acr-lookup-radiohead-creep.json'
import similarArtists from '../../../../../../packages/sources/src/listenbrainz/fixtures/similar-artists-radiohead.json'
import artistRadiohead from '../../../../../../packages/sources/src/youtube/fixtures/artist-radiohead.json'
import radioCreep from '../../../../../../packages/sources/src/youtube/fixtures/radio-creep.json'
import searchArtists from '../../../../../../packages/sources/src/youtube/fixtures/search-artists.json'
import songs from '../../../../../../packages/sources/src/youtube/fixtures/search-songs.json'
import player from '../../../../../../packages/sources/src/youtube/stream/fixtures/visionos-song.json'
import config from '../../../../../../packages/sources/src/youtube/youtube-config.json'
import type { FakeNetworkFixtures } from './fake-network'

/** Radiohead's YouTube Music channel, whose artist page `artist-radiohead.json` is. */
export const RADIOHEAD_CHANNEL = 'UCr_iyUANcn9OX_yy9piYoLw'

/**
 * The fixtures: "Radiohead Creep" on YouTube Music (a songs search, an artists search, Creep's
 * radio and Radiohead's artist page), "Ghosts I - IV" on Internet Archive, and ListenBrainz's
 * lookup of Creep and Radiohead's similar artists.
 */
export const FIXTURES: FakeNetworkFixtures = {
  songs,
  player,
  archiveSearch,
  archiveItems: { nineinchnails_ghosts_I_IV: ninGhosts },
  searches: { [config.search.music.artists]: searchArtists },
  radio: radioCreep,
  browse: { [RADIOHEAD_CHANNEL]: artistRadiohead },
  listenbrainz: {
    'acr-lookup/json': acrLookup,
    'similar-artists/json': similarArtists,
  },
}
