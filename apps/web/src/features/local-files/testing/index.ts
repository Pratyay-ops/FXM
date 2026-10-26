/**
 * Test helpers for local files: a facade on a database of its own with fakes for the folder
 * picker, thumbnails, object URLs and the clock, plus the fake handles and generated audio files
 * of this folder.
 *
 * @module
 */

import type { MakeThumbnail } from '../artwork'
import { openLocalDatabase } from '../database'
import { createLocalFiles, type LocalFilesDeps, resetLocalFiles } from '../local-files'
import { ObjectUrlCache } from '../object-urls'
import { createLocalFilesRepo, memoryHandleStore } from '../repo'
import { readTags } from '../tags'
import type { LocalFileRecord, LocalTags } from '../types'

export * from './audio-files'
export * from './fake-fs'

/** A thumbnail maker that decodes nothing: its URL names the image's size. */
export const fakeThumbnail: MakeThumbnail = async (image) => ({
  url: `data:image/webp;base64,${btoa(`cover-${image.size}`)}`,
  width: 4,
  height: 4,
})

/** Object URLs that record what was created and revoked. */
export function fakeObjectUrls(capacity?: number) {
  const created: string[] = []
  const revoked: string[] = []
  const urls = new ObjectUrlCache(capacity, {
    create: () => {
      const url = `blob:fxm-test/${created.length + 1}`
      created.push(url)
      return url
    },
    revoke: (url) => {
      revoked.push(url)
    },
  })
  return { urls, created, revoked }
}

let databases = 0

/**
 * Dependencies for a local-files facade on a database of its own: handles in memory, the real
 * tag reader, fake thumbnails and object URLs, a clock that moves a second per call, numbered
 * root IDs, a folder picker that is closed (pass `pickDirectory` to pick) and the File System
 * Access API present.
 */
export function testLocalFilesDeps(overrides: Partial<LocalFilesDeps> = {}) {
  databases++
  let clock = Date.UTC(2026, 9, 26, 12)
  let roots = 0
  const objectUrls = fakeObjectUrls()
  const refreshed: string[][] = []
  const deps: LocalFilesDeps = {
    repo: createLocalFilesRepo(openLocalDatabase(`fxm-local-test-${databases}-${Math.random()}`), {
      handles: memoryHandleStore(),
    }),
    readTags,
    thumbnail: fakeThumbnail,
    refreshLibraryTracks: async (tracks) => {
      refreshed.push(tracks.map((track) => track.id))
    },
    pickDirectory: async () => null,
    canKeepFolders: () => true,
    canChooseFolders: () => true,
    objectUrls: objectUrls.urls,
    now: () => {
      clock += 1000
      return clock
    },
    uuid: () => `root-${++roots}`,
    ...overrides,
  }
  return { deps, objectUrls, refreshed }
}

/** A facade on a database of its own; see {@link testLocalFilesDeps}. */
export function testLocalFiles(overrides: Partial<LocalFilesDeps> = {}) {
  const setup = testLocalFilesDeps(overrides)
  return { ...setup, files: createLocalFiles(setup.deps) }
}

/**
 * Makes the app's local files (`getLocalFiles()`) a test facade; see {@link testLocalFilesDeps}.
 * Call `resetLocalFiles()` after each test.
 */
export async function installTestLocalFiles(overrides: Partial<LocalFilesDeps> = {}) {
  const setup = testLocalFilesDeps(overrides)
  const files = await resetLocalFiles(setup.deps)
  return { ...setup, files }
}

/**
 * Makes the app's local files the next visit over the database of `deps` (from
 * {@link installTestLocalFiles}), as after a reload: chosen files are forgotten, kept folders
 * are checked again.
 */
export function reloadTestLocalFiles(deps: LocalFilesDeps) {
  return resetLocalFiles(deps, { newVisit: true })
}

let records = 0

/** A listed file with `tags` (title required), for tests that need records without a scan. */
export function fileRecord(
  tags: Partial<LocalTags> & { title: string },
  extra: Partial<LocalFileRecord> = {},
): LocalFileRecord {
  records++
  return {
    key: `root/${records}.flac`,
    rootId: 'root',
    path: `${records}.flac`,
    id: `id${records}`,
    size: 1000,
    lastModified: 1,
    tags: { artists: [], ...tags },
    format: { codec: 'flac', container: 'flac', tier: 'lossless' },
    readerVersion: 1,
    addedAt: records,
    updatedAt: records,
    ...extra,
  }
}
