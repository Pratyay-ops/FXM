/**
 * The recommendation engine (stage 3.3): pure and deterministic. It pools the candidates the
 * recommendation sources collect (`pool.ts`), scores them against the user's taste
 * (`taste.ts`, `score.ts`), de-duplicates them against the listening history (`history.ts`),
 * diversifies them with MMR and a per-artist cap (`diversify.ts`), and builds Home's shelves
 * (`home.ts`), with Discover and the Daily Mixes kept for their week and day (`period.ts`,
 * `stable.ts`). `seeds.ts` plans what to collect, and `expand.ts` which artists and song
 * searches are worth turning into tracks. `radio.ts` (stage 3.4) grows a queue that runs low
 * from the last plays: endless autoplay radio. See the README.
 *
 * @module
 */

export * from './diversify'
export * from './expand'
export * from './history'
export * from './home'
export * from './identity'
export * from './period'
export * from './pool'
export * from './radio'
export * from './score'
export * from './seeds'
export * from './stable'
export * from './taste'
export * from './types'
