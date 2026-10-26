/**
 * The version numbers and file names of the YouTube resolver module and config, in one file that
 * imports nothing: the module build and the signing script read it with Node directly.
 *
 * Versions continue across contracts and schemas: the first module of contract 2 has a higher
 * version than the last of contract 1, and so does a config of a new schema. Devices keep one
 * floor per kind, so a version that started again from 1 would be refused as a rollback.
 *
 * @module
 */

/**
 * The contract between an app and the YouTube module: the shape of `youtubeModule` and of
 * everything that crosses between them (`api.ts`, frozen in `contract-1.ts`). An app loads only
 * modules of its own contract, from a file named after it. Change it only when that shape
 * changes in a way older apps can't take.
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

/**
 * The schema of the config the app fetches: `YOUTUBE_CONFIG_SCHEMA` of `../config.ts`, repeated
 * here because this file imports nothing (a test keeps the two equal). A config published under
 * one file name must stay readable by every module that fetches that name; a config that needs
 * a newer module needs a new schema, and so a new file name.
 */
export const YOUTUBE_CONFIG_SCHEMA = 1

/** The artifact kind of the YouTube config. */
export const YOUTUBE_CONFIG_KIND = 'youtube-config'

/** The config's file name on the site. It carries the schema; its version is its `revision`. */
export const YOUTUBE_CONFIG_FILE = `youtube-config-${YOUTUBE_CONFIG_SCHEMA}.json`
