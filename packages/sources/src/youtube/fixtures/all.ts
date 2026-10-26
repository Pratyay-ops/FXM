/**
 * Every recorded fixture by name, for checks that cover them all (see `sanitize.test.ts`).
 *
 * @module
 */

import albumNotFound from './album-not-found.json'
import albumPabloHoney from './album-pablo-honey.json'
import artistRadiohead from './artist-radiohead.json'
import channelUploader from './channel-uploader.json'
import nextCreepSong from './next-creep-song.json'
import nextCreepVideo from './next-creep-video.json'
import nextNotFound from './next-not-found.json'
import nextUpload from './next-upload.json'
import nextWebCreep from './next-web-creep.json'
import playlistBSides from './playlist-b-sides.json'
import playlistOlakPabloHoney from './playlist-olak-pablo-honey.json'
import playlistPopular from './playlist-popular.json'
import playlistPopular2 from './playlist-popular-2.json'
import radioArtist from './radio-artist.json'
import radioCreep from './radio-creep.json'
import radioCreep2 from './radio-creep-2.json'
import searchAlbums from './search-albums.json'
import searchArtists from './search-artists.json'
import searchPlaylists from './search-playlists.json'
import searchSongs from './search-songs.json'
import searchSongs2 from './search-songs-2.json'
import searchTop from './search-top.json'
import searchVideos from './search-videos.json'
import suggest from './suggest.json'
import webSearchChannels from './web-search-channels.json'
import webSearchPlaylists from './web-search-playlists.json'
import webSearchVideos from './web-search-videos.json'

/** The recorded fixtures, by file name without `.json`. */
export const RECORDED_FIXTURES: Readonly<Record<string, unknown>> = {
  'album-not-found': albumNotFound,
  'album-pablo-honey': albumPabloHoney,
  'artist-radiohead': artistRadiohead,
  'channel-uploader': channelUploader,
  'next-creep-song': nextCreepSong,
  'next-creep-video': nextCreepVideo,
  'next-not-found': nextNotFound,
  'next-upload': nextUpload,
  'next-web-creep': nextWebCreep,
  'playlist-b-sides': playlistBSides,
  'playlist-olak-pablo-honey': playlistOlakPabloHoney,
  'playlist-popular': playlistPopular,
  'playlist-popular-2': playlistPopular2,
  'radio-artist': radioArtist,
  'radio-creep': radioCreep,
  'radio-creep-2': radioCreep2,
  'search-albums': searchAlbums,
  'search-artists': searchArtists,
  'search-playlists': searchPlaylists,
  'search-songs': searchSongs,
  'search-songs-2': searchSongs2,
  'search-top': searchTop,
  'search-videos': searchVideos,
  suggest: suggest,
  'web-search-channels': webSearchChannels,
  'web-search-playlists': webSearchPlaylists,
  'web-search-videos': webSearchVideos,
}
