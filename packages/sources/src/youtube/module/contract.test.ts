/**
 * The module contract guard: the type checker (`make typecheck`) fails here when `api.ts` drifts
 * from the frozen `contract-1.ts` in either direction, before such a module could be signed and
 * reach installed apps. The run-time test only reports what the type checker proved.
 */
import { describe, expect, it } from 'vitest'
import { YOUTUBE_CONFIG_SCHEMA as CONFIG_SCHEMA } from '../config'
import type { YouTubeModule, YouTubeModuleOptions, YouTubeModuleProviders } from './api'
import type * as Contract1 from './contract-1'
import { YOUTUBE_CONFIG_FILE, YOUTUBE_CONFIG_SCHEMA, YOUTUBE_MODULE_API } from './version'

/** `true` when each type is assignable to the other. */
type Compatible<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** Compiles only for `true`. */
function proven<T extends true>(value: T): T {
  return value
}

const contract1 = {
  // Old apps take a new module, and new apps take an old one.
  module: proven<Compatible<YouTubeModule, Contract1.YouTubeModule>>(true),
  providers: proven<Compatible<YouTubeModuleProviders, Contract1.YouTubeModuleProviders>>(true),
  // Old apps pass their options to a new module, and new apps theirs to an old one.
  options: proven<Compatible<YouTubeModuleOptions, Contract1.YouTubeModuleOptions>>(true),
}

describe('the module contract', () => {
  it('stays compatible with the frozen contract 1 in both directions', () => {
    expect(YOUTUBE_MODULE_API).toBe(1)
    expect(Object.values(contract1)).toEqual([true, true, true])
  })

  it('names the config file after the schema the YouTube code reads', () => {
    expect(YOUTUBE_CONFIG_SCHEMA).toBe(CONFIG_SCHEMA)
    expect(YOUTUBE_CONFIG_FILE).toBe(`youtube-config-${CONFIG_SCHEMA}.json`)
  })
})
