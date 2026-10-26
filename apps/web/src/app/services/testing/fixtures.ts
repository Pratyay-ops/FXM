/**
 * The recorded answers the composition root's Vitest tests serve through the fake network:
 * the providers' own sanitized fixtures (see their READMEs), read from their packages so there
 * is one copy of each.
 *
 * @module
 */

import ninGhosts from '../../../../../../packages/sources/src/archive/fixtures/item-nin-ghosts.json'
import archiveSearch from '../../../../../../packages/sources/src/archive/fixtures/search-nin-ghosts.json'
import songs from '../../../../../../packages/sources/src/youtube/fixtures/search-songs.json'
import player from '../../../../../../packages/sources/src/youtube/stream/fixtures/visionos-song.json'
import type { FakeNetworkFixtures } from './fake-network'

/** The fixtures: "Radiohead Creep" on YouTube Music, "Ghosts I - IV" on Internet Archive. */
export const FIXTURES: FakeNetworkFixtures = {
  songs,
  player,
  archiveSearch,
  archiveItems: { nineinchnails_ghosts_I_IV: ninGhosts },
}
