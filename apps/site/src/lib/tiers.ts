/**
 * Copy about FXM's tiers: what the web app plays without FXM Connect, and what the extension
 * does. Each sentence that changes once the experimental Lite tier is out (`AVAILABLE.lite` in
 * src/config.ts, which stage 2.8 turns on) takes the flag, so both versions stay side by side and
 * tested:
 *
 * - **Lite off:** without FXM Connect, the web app plays only free sources (Internet Archive and
 *   Jamendo), and YouTube Music and Spotify need the extension.
 * - **Lite on:** without FXM Connect, the web app also plays YouTube Music in the experimental
 *   Lite tier, where the browser allows it (docs/ARCHITECTURE.md §8); Spotify still needs the
 *   extension.
 */

/**
 * What FXM Connect does, in a sentence that is true of every version of it. Besides the headers,
 * it always relays Spotify's public server time (`spotify-server-time`, without credentials), and
 * its Spotify login bridge is opt-in, so no one feature is its "only other part".
 */
export const CONNECT_DOES =
  "it adjusts a few headers on FXM's own requests and fetches Spotify's public server time when the web app asks; its option to use your Spotify login is off unless you turn it on"

/** What Music mode plays (an owner decision, 2026-10-25): songs, from any source. */
export const MUSIC_MODE =
  "Songs only, from any source: YouTube Music's clean album audio, and free music from Internet Archive and Jamendo."

/** The Spotify account item: the sync only reads. */
export const SPOTIFY_ACCOUNT =
  'Connect your Spotify account for a read-only sync of your recommendations, liked songs and playlists'

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
export function noExtensionHighlight(lite: boolean): {
  readonly title: string
  readonly text: string
  readonly experimental: boolean
} {
  return lite
    ? {
        title: 'No extension needed to start',
        text: `Without FXM Connect, the web app plays free music from Internet Archive and Jamendo, and YouTube Music in ${LITE} where the browser allows it. Add the extension for Spotify.`,
        experimental: true,
      }
    : {
        title: 'Free music, no extension needed',
        text: 'Without FXM Connect, the web app still plays free music from Internet Archive and Jamendo, and invites you to add the extension for YouTube Music and Spotify.',
        experimental: false,
      }
}

/** The first sentences of the "Get FXM" web card. */
export function webCardIntro(lite: boolean): string {
  return lite
    ? `Runs in your browser. Add the free FXM Connect extension for YouTube Music and Spotify, or try YouTube Music without an install in ${LITE}, where the browser allows it.`
    : 'Runs in your browser. Add the free FXM Connect extension to use YouTube Music and Spotify.'
}

/** The web card's note for visitors without the extension. */
export function noExtensionNote(lite: boolean): string {
  return lite
    ? `No extension, or on a phone or tablet? The web app plays free music from Internet Archive and Jamendo, and YouTube Music in ${LITE} where the browser allows it.`
    : 'No extension, or on a phone or tablet? The web app still plays free music from Internet Archive and Jamendo.'
}

/** Step 2 of "How it works": how the device reaches the music services. */
export function howItWorksStep(lite: boolean): string {
  const start = `When you search or press play, FXM asks YouTube Music, Internet Archive, Jamendo and the other services directly from your device. Some of them, like YouTube Music, don't answer other websites. In a browser, the FXM Connect extension lets the web app reach them: ${CONNECT_DOES}.`
  return lite
    ? `${start} Without it, ${LITE} reaches YouTube Music where the browser allows it. The desktop and Android apps need neither.`
    : `${start} The desktop and Android apps don't need it.`
}

/** The label of the app box in the "How it works" diagram. */
export function diagramLabel(lite: boolean): string {
  return lite ? 'Web app, desktop or Android' : 'Web app with FXM Connect, desktop or Android'
}

/** The FAQ's question and answer about the extension. */
export function extensionFaq(lite: boolean): {
  readonly question: string
  readonly answers: readonly string[]
} {
  const why = `For your safety, browsers don't let one website read data from another unless that site allows it. Music services such as ${lite ? 'Spotify' : 'YouTube Music'} don't, so a regular website can't ${lite ? 'reach' : 'search or stream from'} them. The free FXM Connect extension lets the web app reach them from your own browser: ${CONNECT_DOES}. Nothing goes through FXM servers, because there aren't any.`
  return lite
    ? {
        question: 'Do I need an extension?',
        answers: [
          `Not to start. Without one, the web app plays free music from Internet Archive and Jamendo, and YouTube Music in ${LITE}, where the browser allows it. Lite relies on a way of reaching YouTube Music that YouTube doesn't document, so it may stop working at any time.`,
          `For Spotify, add FXM Connect. ${why} The desktop and Android apps don't need it.`,
        ],
      }
    : {
        question: 'Why does the web app need an extension?',
        answers: [
          why,
          "Without the extension, the web app still works with free sources (Internet Archive and Jamendo) and invites you to add FXM Connect for YouTube Music and Spotify. The desktop and Android apps don't need it.",
        ],
      }
}

/** What the FAQ's browser answer says FXM Connect is needed for. */
export function connectNeededFor(lite: boolean): string {
  return lite
    ? "Spotify (and for YouTube Music where Lite doesn't work)"
    : 'YouTube Music and Spotify'
}

/** The FAQ's sentence on phones, tablets and other browsers, before the one about the apps. */
export function otherBrowsersAnswer(lite: boolean): string {
  return lite
    ? `On phones and tablets, and in other browsers such as Safari, the web app plays free music from Internet Archive and Jamendo, and YouTube Music in ${LITE} where the browser allows it. Lite has been tried in Chrome and Firefox on a computer; it isn't tested in Safari or on phones yet.`
    : 'On phones and tablets, and in other browsers such as Safari, the web app plays free music from Internet Archive and Jamendo.'
}

/** The end of the FAQ's iPhone answer: what plays there. */
export function iPhoneAnswer(lite: boolean): string {
  return lite
    ? `FXM Connect isn't available there. The web app plays free sources such as Internet Archive and Jamendo, and YouTube Music in ${LITE} if Safari allows it: Lite isn't tested on iPhone and iPad yet.`
    : "FXM Connect isn't available there, so the web app plays from free sources such as Internet Archive and Jamendo."
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
