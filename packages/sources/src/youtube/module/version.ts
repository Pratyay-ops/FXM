/**
 * The version numbers of the YouTube resolver module, in one file that imports nothing: the
 * module build and the signing script read it with Node directly.
 *
 * @module
 */

/**
 * The contract between an app and the YouTube module: the shape of `youtubeModule` and of
 * everything that crosses between them (the provider interfaces and `@fxm/core`'s entities). An
 * app loads only modules of its own contract, from a file named after it. Change it only when
 * that shape changes in a way older apps can't take.
 */
export const YOUTUBE_MODULE_API = 1

/**
 * This module's version. Raise it by one for every module published: apps take a module only
 * when its version is higher than the one they have.
 */
export const YOUTUBE_MODULE_VERSION = 1

/** The artifact kind of the module, as signed statements name it. */
export const YOUTUBE_MODULE_KIND = 'youtube-module'

/** The module's file name on the site. It carries the contract version. */
export const YOUTUBE_MODULE_FILE = `youtube-module-${YOUTUBE_MODULE_API}.js`

/** The artifact kind of the YouTube config. */
export const YOUTUBE_CONFIG_KIND = 'youtube-config'

/** The config's file name on the site. Its version is its `revision`. */
export const YOUTUBE_CONFIG_FILE = 'youtube-config.json'
