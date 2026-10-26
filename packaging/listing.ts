/**
 * What FXM's listings say, in one place: F-Droid's (fastlane), the Flatpak's AppStream metainfo
 * and winget's manifests are all generated from it, so they never disagree. Public text: it
 * follows the trademark rules of docs/LEGAL.md (services named in plain words, only to say what
 * FXM works with; the non-affiliation notice goes with it), and the tests in listing.test.ts
 * keep it within each store's limits.
 *
 * Keep it current: it describes what the Android and desktop apps do in the release a listing is
 * built from. Downloads (stages 6.4 and 7.4) and the Spotify login (6.5, 7.4), with the account
 * sync that needs it (3.5), are left out until they ship in those apps.
 *
 * Imports nothing, so that the release workflow can run the generators with Node alone.
 *
 * @module
 */

/** The app's name. */
export const APP_NAME = 'FXM'

/** The Android application ID (apps/mobile), which F-Droid and Obtainium know FXM by. */
export const ANDROID_ID = 'io.github.pratyayops.fxm'

/**
 * The Flatpak ID. Flathub derives the repository from an `io.github.` ID and checks that it
 * exists: `io.github.pratyay_ops.FXM` is https://github.com/pratyay-ops/FXM (an underscore
 * stands for the dash, which IDs can't hold). The desktop app's own identifier,
 * `io.github.pratyayops.fxm`, would name a GitHub account that doesn't exist (checked
 * 2026-10-26), so the Flatpak can't use it (flatpak/README.md).
 */
export const FLATPAK_ID = 'io.github.pratyay_ops.FXM'

/** The executable that the desktop app's packages install (apps/desktop/src-tauri/Cargo.toml). */
export const DESKTOP_BINARY = 'fxm'

/** The GitHub owner, as the URLs spell it. */
export const GITHUB_OWNER = 'Pratyay-ops'

export const REPO_URL = `https://github.com/${GITHUB_OWNER}/FXM`
export const ISSUES_URL = `${REPO_URL}/issues`
export const RELEASES_URL = `${REPO_URL}/releases`
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`
export const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`
export const SITE_URL = 'https://fxmusic.pages.dev'
export const PRIVACY_URL = `${SITE_URL}/privacy`

/** FXM's license, as SPDX names it. */
export const LICENSE = 'Apache-2.0'

/**
 * Who publishes FXM. LEGAL.md keeps people's names out of public text unless the owner provides
 * one, so it is the project: "FXM" is also the publisher the desktop app's installers write
 * (`bundle.publisher` in tauri.conf.json), which winget compares with its manifest.
 */
export const PUBLISHER = 'FXM'

/** The developer, as AppStream and F-Droid name one: the project's contributors. */
export const DEVELOPER = 'FXM contributors'

/**
 * The summary next to the name: what FXM does, in a few words. Flathub asks for 10 to 25
 * characters (35 at most), sentence case, no full stop and no "free and open source"; F-Droid
 * for at most 80 characters without a trailing full stop.
 */
export const SUMMARY = 'Play practically any song'

/** A one-sentence description, for winget's short description. */
export const TAGLINE = 'A free, open-source music player: search and play practically any song.'

/** The non-affiliation notice of docs/LEGAL.md, for listings that name the services. */
export const NOTICE =
  'FXM is an independent open-source project, not affiliated with or endorsed by YouTube, Google or Spotify, and it hosts no music. You are responsible for following the terms of the services you use with FXM and the laws where you live.'

/** Which app a listing is for. */
export type ListingPlatform = 'android' | 'desktop'

/** A listing's description: paragraphs, with one list of features after the first. */
export interface Description {
  readonly intro: string
  readonly features: readonly string[]
  readonly paragraphs: readonly string[]
}

const FEATURES = [
  'Two modes: Music plays songs only, from YouTube Music’s album audio and free music from Internet Archive; Music + Video also plays any YouTube video, such as covers and live sets, as music.',
  'Spotify built in, and switchable: search Spotify’s catalog and get its recommendations on your home feed.',
  'A home feed made on your device, with quick picks and daily mixes.',
  'Endless radio: when your queue runs low, FXM adds songs like the ones you just played, steered by your likes and skips.',
  'Your library: likes, playlists in the order you choose, your listening history and backups.',
  'Synced lyrics from LRCLIB, and scrobbling to Last.fm and ListenBrainz once you connect an account.',
] as const

const PLAYBACK: Readonly<Record<ListingPlatform, string>> = {
  android:
    'Music keeps playing with the screen off, with controls in the notification and on the lock screen.',
  desktop:
    'Music keeps playing from the tray with the window closed, and the system’s media controls and keys work.',
}

const PRIVACY =
  'No servers, no accounts and no ads or tracking from FXM. FXM runs on your device and connects it directly to the services it works with. Your library stays on your device; sync to a secret gist on your own GitHub account is optional.'

/** The description of a platform's app. */
export function description(platform: ListingPlatform): Description {
  return {
    intro:
      'FXM is a free, open-source music player. Search YouTube Music, Spotify’s catalog and free music from Internet Archive in one place, and play practically any song.',
    features: [...FEATURES, PLAYBACK[platform]],
    paragraphs: [PRIVACY, NOTICE],
  }
}

/**
 * Why F-Droid marks FXM with the NonFreeNet anti-feature ("apps that promote or depend entirely
 * on a proprietary network service", F-Droid's Anti-Features page, read 2026-10-26): its main
 * features use YouTube Music and Spotify. Short enough that `fdroid rewritemeta` keeps it on one
 * line.
 */
export const NON_FREE_NET_REASON =
  'Uses YouTube Music, Spotify and Last.fm: non-free network services.'

/** The listing's keywords (AppStream, winget tags). */
export const KEYWORDS = ['music', 'player', 'audio', 'lyrics', 'playlist', 'streaming'] as const
