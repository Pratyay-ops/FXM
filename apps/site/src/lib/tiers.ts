/**
 * Copy about FXM's tiers: what the web app plays without FXM Connect, and what the extension
 * does. Each sentence that changes once the experimental Lite tier is out (`AVAILABLE.lite` in
 * src/config.ts, which stage 2.8 turns on) takes the flag, so both versions stay side by side and
 * tested:
 *
 * - **Lite off:** without FXM Connect, the web app plays only free sources, and YouTube Music and
 *   Spotify need the extension.
 * - **Lite on:** without FXM Connect, the web app also plays YouTube Music in the experimental
 *   Lite tier, where the browser allows it (docs/ARCHITECTURE.md §8); Spotify still needs the
 *   extension.
 *
 * The sentences that name the free sources also take `AVAILABLE.jamendo`: Internet Archive always,
 * Jamendo only in a build that has FXM's public Jamendo client_id.
 *
 * The web card's no-extension note and the FAQ's answer for phones also change once the signed
 * Firefox add-on is out (`AVAILABLE.firefox`). src/lib/connect.ts writes who those sentences are
 * for and takes what the web app plays from `noExtensionPlays` and `otherBrowsersPlays` here.
 *
 * The sentences that mention the desktop and Android apps take which of them are out (`Apps`:
 * `AVAILABLE` itself, or any object with its `desktop` and `android` flags), so an app that isn't
 * out is described as coming soon, never in the present tense.
 */

import { joinList } from './copy'

/** Which of FXM's apps are out: `AVAILABLE.desktop` and `AVAILABLE.android`. */
export interface Apps {
  readonly desktop: boolean
  readonly android: boolean
}

const APP_NAMES = [
  ['desktop', 'desktop'],
  ['android', 'Android'],
] as const

/** The names of the apps that are out (`released`), or of those that aren't, in a fixed order. */
function appNames(apps: Apps, released: boolean): string[] {
  return APP_NAMES.filter(([key]) => apps[key] === released).map(([, name]) => name)
}

/**
 * That the apps need neither FXM Connect nor Lite (`either`), or not FXM Connect (`it`): in the
 * present tense for the apps that are out, in the future tense, coming soon, for the others.
 */
function appsNeedNo(apps: Apps, what: 'it' | 'either'): string {
  const out = appNames(apps, true)
  const soon = appNames(apps, false)
  const sentences: string[] = []
  if (out.length > 0) {
    const one = out.length === 1
    sentences.push(
      what === 'it'
        ? `The ${joinList(out)} ${one ? "app doesn't" : "apps don't"} need it.`
        : `The ${joinList(out)} ${one ? 'app needs' : 'apps need'} neither.`,
    )
  }
  if (soon.length > 0) {
    const noun = soon.length === 1 ? 'app' : 'apps'
    sentences.push(`The ${joinList(soon)} ${noun}, coming soon, won't need ${what}.`)
  }
  return sentences.join(' ')
}

/** "A, B or C", as the diagram's label lists where FXM runs. */
const disjunction = new Intl.ListFormat('en-GB', { style: 'long', type: 'disjunction' })

/**
 * What FXM Connect does, in a sentence that is true of every version of it. Besides the headers,
 * it always relays Spotify's public server time (`spotify-server-time`, without credentials), and
 * its Spotify login bridge is opt-in, so no one feature is its "only other part". What uses the
 * login is the web app's experimental Spotify account sync (`SPOTIFY_ACCOUNT_NOTE`).
 */
export const CONNECT_DOES =
  "it adjusts a few headers on FXM's own requests and fetches Spotify's public server time when the web app asks; its option to use your Spotify login, for the experimental Spotify account sync, is off unless you turn it on"

/**
 * The free sources the web app plays everywhere: Internet Archive, and Jamendo in a build that
 * offers it (`AVAILABLE.jamendo`).
 */
export function freeSources(jamendo: boolean): string {
  return jamendo ? 'Internet Archive and Jamendo' : 'Internet Archive'
}

/** What Music mode plays (an owner decision, 2026-10-25): songs, from any source. */
export function musicMode(jamendo: boolean): string {
  return `Songs only, from any source: YouTube Music's clean album audio, and free music from ${freeSources(jamendo)}.`
}

/** The lossless sources, after "where the source has it" in the downloads feature. */
export function losslessSources(jamendo: boolean): string {
  return jamendo ? '(Internet Archive, Jamendo)' : '(Internet Archive; Jamendo is coming soon)'
}

/** The FAQ's answer on lossless audio: who offers it. */
export function losslessAnswer(jamendo: boolean): string {
  return jamendo
    ? 'Yes, where the source has it. Internet Archive and Jamendo offer real lossless FLAC, which FXM can play.'
    : 'Yes, where the source has it. Internet Archive offers real lossless FLAC, which FXM can play, and so will Jamendo (coming soon).'
}

/**
 * The Spotify account item: the sync only reads. The checklist shows it with the Experimental
 * badge and, under the list, `SPOTIFY_ACCOUNT_NOTE`.
 */
export const SPOTIFY_ACCOUNT =
  'Connect your Spotify account for a read-only sync of your recommendations, liked songs and playlists'

/**
 * Why the Spotify account sync is experimental, wherever the site offers it, and that it is
 * opt-in. It has been tested only against a stand-in for Spotify, never a real account, and the
 * owner decided to ship it labelled so (apps/web/src/features/spotify-account/README.md, "Manual
 * test with a real account"). When the sync can't read an answer, Settings says why, and no copy
 * is emptied (the same README, "Never takes what it can't read for empty"). Once the manual test
 * has passed, drop this note, the Experimental badge next to `SPOTIFY_ACCOUNT` and the word
 * "experimental" in the other sentences about the sync (tiers.test.ts lists where they are).
 */
export const SPOTIFY_ACCOUNT_NOTE =
  "Account sync is experimental, and off until you connect your account. It has been tested with a stand-in for Spotify, not yet with real accounts: if it fails, Settings says why, and FXM never empties a copy because of an answer it couldn't read."

/**
 * Lite, as the copy names it, marked experimental: a tier, as the web app calls it, not a mode,
 * which the Features section uses for Music and Music + Video.
 */
const LITE = 'the experimental Lite tier'

/** The note under the hero's buttons, before the sentence about the apps. */
export function heroNote(lite: boolean): string {
  return lite
    ? `In the browser, YouTube Music plays without an install in ${LITE}, where the browser allows it. Spotify needs the free FXM Connect extension.`
    : 'In the browser, YouTube Music and Spotify need the free FXM Connect extension.'
}

/** The features section's highlight about using the web app without the extension. */
export function noExtensionHighlight(
  lite: boolean,
  jamendo: boolean,
): {
  readonly title: string
  readonly text: string
  readonly experimental: boolean
} {
  return lite
    ? {
        title: 'No extension needed to start',
        text: `Without FXM Connect, the web app plays free music from ${freeSources(jamendo)}, and YouTube Music in ${LITE} where the browser allows it. Add the extension for Spotify.`,
        experimental: true,
      }
    : {
        title: 'Free music, no extension needed',
        text: `Without FXM Connect, the web app still plays free music from ${freeSources(jamendo)}, and invites you to add the extension for YouTube Music and Spotify.`,
        experimental: false,
      }
}

/** The first sentences of the "Get FXM" web card. */
export function webCardIntro(lite: boolean): string {
  return lite
    ? `Runs in your browser. Add the free FXM Connect extension for YouTube Music and Spotify, or try YouTube Music without an install in ${LITE}, where the browser allows it.`
    : 'Runs in your browser. Add the free FXM Connect extension to use YouTube Music and Spotify.'
}

/**
 * What the web card's note for visitors without the extension says the web app plays, after the
 * question of who the note is for (`noExtensionNote` in src/lib/connect.ts).
 */
export function noExtensionPlays(lite: boolean, jamendo: boolean): string {
  return lite
    ? `The web app plays free music from ${freeSources(jamendo)}, and YouTube Music in ${LITE} where the browser allows it.`
    : `The web app still plays free music from ${freeSources(jamendo)}.`
}

/**
 * Step 1 of "How it works": how FXM opens, in the browser and in the apps, which are coming soon
 * until they are out.
 */
export function openingStep(apps: Apps): string {
  const out = appNames(apps, true)
  const soon = appNames(apps, false)
  const sentences = ['On the web, your browser loads the app like any other page, then runs it.']
  if (out.length > 0) sentences.push(`On ${joinList(out)}, it's an app you install.`)
  if (soon.length > 0) {
    sentences.push(
      out.length > 0
        ? `On ${joinList(soon)}, it will be one too (coming soon).`
        : `On ${joinList(soon)}, it will be an app you install (coming soon).`,
    )
  }
  return sentences.join(' ')
}

/** Step 2 of "How it works": how the device reaches the music services. */
export function howItWorksStep(lite: boolean, jamendo: boolean, apps: Apps): string {
  const start = `When you search or press play, FXM asks YouTube Music, Internet Archive${jamendo ? ', Jamendo' : ''} and the other services directly from your device. Some of them, like YouTube Music, don't answer other websites. In a browser, the FXM Connect extension lets the web app reach them: ${CONNECT_DOES}.`
  return lite
    ? `${start} Without it, ${LITE} reaches YouTube Music where the browser allows it. ${appsNeedNo(apps, 'either')}`
    : `${start} ${appsNeedNo(apps, 'it')}`
}

/**
 * The label of the app box in the "How it works" diagram: where FXM runs today, then the apps
 * that are coming soon.
 */
export function diagramLabel(lite: boolean, apps: Apps): string {
  const web = lite ? 'Web app' : 'Web app with FXM Connect'
  const where = disjunction.format([web, ...appNames(apps, true)])
  const soon = appNames(apps, false)
  return soon.length === 0 ? where : `${where} (${joinList(soon)} coming soon)`
}

/** The FAQ's question and answer about the extension. */
export function extensionFaq(
  lite: boolean,
  jamendo: boolean,
  apps: Apps,
): {
  readonly question: string
  readonly answers: readonly string[]
} {
  const why = `For your safety, browsers don't let one website read data from another unless that site allows it. Music services such as ${lite ? 'Spotify' : 'YouTube Music'} don't, so a regular website can't ${lite ? 'reach' : 'search or stream from'} them. The free FXM Connect extension lets the web app reach them from your own browser: ${CONNECT_DOES}. Nothing goes through FXM servers, because there aren't any.`
  return lite
    ? {
        question: 'Do I need an extension?',
        answers: [
          `Not to start. Without one, the web app plays free music from ${freeSources(jamendo)}, and YouTube Music in ${LITE}, where the browser allows it. Lite relies on a way of reaching YouTube Music that YouTube doesn't document, so it may stop working at any time.`,
          `For Spotify, add FXM Connect. ${why} ${appsNeedNo(apps, 'it')}`,
        ],
      }
    : {
        question: 'Why does the web app need an extension?',
        answers: [
          why,
          `Without the extension, the web app still works with free sources (${freeSources(jamendo)}) and invites you to add FXM Connect for YouTube Music and Spotify. ${appsNeedNo(apps, 'it')}`,
        ],
      }
}

/** What the FAQ's browser answer says FXM Connect is needed for. */
export function connectNeededFor(lite: boolean): string {
  return lite
    ? "Spotify (and for YouTube Music where Lite doesn't work)"
    : 'YouTube Music and Spotify'
}

/**
 * What the FAQ's answer for phones, tablets and other browsers says the web app plays there: after
 * where FXM Connect can't be added and before the sentence about the apps (`phonesAnswer` in
 * src/lib/connect.ts).
 */
export function otherBrowsersPlays(lite: boolean, jamendo: boolean): string {
  return lite
    ? `the web app plays free music from ${freeSources(jamendo)}, and YouTube Music in ${LITE} where the browser allows it. Lite has been tried in Chrome and Firefox on a computer; it isn't tested in Safari or on phones yet.`
    : `the web app plays free music from ${freeSources(jamendo)}.`
}

/** The end of the FAQ's iPhone answer: what plays there. */
export function iPhoneAnswer(lite: boolean, jamendo: boolean): string {
  return lite
    ? `FXM Connect isn't available there. The web app plays free music from ${freeSources(jamendo)}, and YouTube Music in ${LITE} if Safari allows it: Lite isn't tested on iPhone and iPad yet.`
    : `FXM Connect isn't available there, so the web app plays free music from ${freeSources(jamendo)}.`
}

/**
 * The privacy page's sentence on the request the web app sends YouTube Music when it starts
 * without FXM Connect: the Lite tier's self-test (one `get_search_suggestions` call from the
 * sandbox), which runs whatever the flag says, unless Lite's kill switch is on.
 */
export function privacyLiteCheck(lite: boolean): string {
  return lite
    ? 'Without FXM Connect, the web app also sends YouTube Music one request when it starts, to check whether the experimental Lite tier works in your browser.'
    : 'Without FXM Connect, the web app also sends YouTube Music one request when it starts, to check whether it can reach YouTube Music without the extension.'
}
