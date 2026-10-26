/**
 * What each distribution of FXM may update by itself. The standard builds (GitHub Releases)
 * download signed code updates and check for new app versions. F-Droid builds do neither
 * without the user: F-Droid's inclusion policy (Security & Legal Compliance, item 5, read
 * 2026-10-26) says that apps "must not download additional executable binary files (e.g.
 * add-ons, auto-updates, etc.) without explicit user consent", that consent must be opt-in and
 * no harder to decline than to accept, and that it must clearly explain that the user is
 * choosing to bypass F-Droid's checks.
 *
 * @module
 */

import { FxmError } from '@fxm/core'

/** Every {@link Distribution}. */
export const DISTRIBUTIONS = ['standard', 'fdroid'] as const

/**
 * Where a build is distributed: `standard` (GitHub Releases, and the web app) or `fdroid` (built
 * by F-Droid from source, stage R.3).
 */
export type Distribution = (typeof DISTRIBUTIONS)[number]

/**
 * Reads a build flag, such as `FXM_DISTRIBUTION`, in any case: `fdroid` (or `f-droid`) makes an
 * F-Droid build; `standard`, an empty value or none the standard one.
 *
 * @throws FxmError `Unsupported` for any other value, so that a typo in a build recipe fails the
 * build instead of making a standard build, which would download code without asking.
 */
export function parseDistribution(value: unknown): Distribution {
  if (value === undefined || value === null) return 'standard'
  const name = typeof value === 'string' ? value.trim().toLowerCase() : undefined
  if (name === '' || name === 'standard') return 'standard'
  if (name === 'fdroid' || name === 'f-droid') return 'fdroid'
  throw new FxmError(
    'Unsupported',
    `FXM_DISTRIBUTION is ${JSON.stringify(String(value))}: it must be standard or fdroid`,
  )
}

/** What a build may update by itself. */
export interface UpdatePolicy {
  /** Whether FXM checks for new versions of the app itself (stages 6.6 and 7.5). */
  readonly appUpdateCheck: boolean
  /**
   * Whether downloaded code, such as the YouTube resolver module, waits for the user's opt-in
   * ({@link CODE_UPDATES_CONSENT}). Data, such as the YouTube config, never does.
   */
  readonly codeNeedsOptIn: boolean
}

/** The update policy of a distribution. */
export function updatePolicy(distribution: Distribution): UpdatePolicy {
  return distribution === 'fdroid'
    ? { appUpdateCheck: false, codeNeedsOptIn: true }
    : { appUpdateCheck: true, codeNeedsOptIn: false }
}

/**
 * The opt-in an F-Droid build shows before it downloads FXM's YouTube code, and the label of
 * the setting that changes it later. Show `accept` and `decline` as equal choices (the same
 * style and size, neither preselected): the policy forbids making declining harder.
 */
export const CODE_UPDATES_CONSENT = {
  title: 'Download YouTube fixes from FXM?',
  body: [
    'YouTube changes often. To keep it working between app releases, FXM can download updated YouTube code from FXM’s website when the app starts.',
    'That code comes from FXM and is signed by its developer. It does not come from F-Droid: if you turn this on, you choose to bypass F-Droid’s checks for it, because F-Droid only reviews and builds the app you installed.',
    'You can turn it off again at any time in Settings.',
  ],
  accept: 'Turn on',
  decline: 'Not now',
  setting: 'Download YouTube fixes from FXM (bypasses F-Droid’s checks)',
} as const
