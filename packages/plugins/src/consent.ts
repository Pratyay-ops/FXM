/**
 * What each distribution of FXM asks before plugins can be used, and the words it asks with.
 *
 * Every build installs a plugin only from an address or a file the user picks, after showing its
 * declared hosts, and updates it only after the user approves. F-Droid builds ask one more
 * question first: F-Droid's inclusion policy (Security & Legal Compliance, item 5; the text of
 * 2026-10-26, quoted in `@fxm/platform`'s `src/updates/README.md`) says that apps "must not
 * download additional executable binary files (e.g. add-ons, auto-updates, etc.) without
 * explicit user consent", that consent must be opt-in and no harder to decline than to accept,
 * and that it must clearly explain that the user is choosing to bypass F-Droid's checks. So an
 * F-Droid build keeps plugins off, downloads and runs none and shows no way to add one, until
 * the user turns them on with {@link PLUGINS_CONSENT}.
 *
 * The distribution comes from the build (`parseDistribution` of `@fxm/platform`, the flag stage
 * R.3's F-Droid build sets).
 *
 * @module
 */

import type { Distribution } from '@fxm/platform'

/** What a build asks before plugins can be used. */
export interface PluginPolicy {
  /**
   * Whether plugins stay off until the user opts in with {@link PLUGINS_CONSENT}: `true` in
   * F-Droid builds.
   */
  readonly needsOptIn: boolean
}

/** The plugin policy of a distribution. */
export function pluginPolicy(distribution: Distribution): PluginPolicy {
  return { needsOptIn: distribution === 'fdroid' }
}

/**
 * The opt-in an F-Droid build shows before plugins can be used, and the label of the setting
 * that turns them off again. Show `accept` and `decline` as equal choices (the same style and
 * size, neither preselected): the policy forbids making declining harder. Turning the setting
 * on again asks again.
 */
export const PLUGINS_CONSENT = {
  title: 'Turn on plugins?',
  body: [
    'Plugins add music sources and ways to play songs that other people write. With plugins on, FXM downloads a plugin only from an address or a file you choose, shows which addresses it can contact, and asks before it installs an update.',
    'Plugins are code from their authors. They don’t come from F-Droid, and F-Droid hasn’t checked them: if you turn this on, you choose to bypass F-Droid’s checks for every plugin you add.',
    'You can turn plugins off again at any time in Settings. FXM then runs none of them.',
  ],
  accept: 'Turn on',
  decline: 'Not now',
  setting: 'Plugins (bypasses F-Droid’s checks)',
} as const
