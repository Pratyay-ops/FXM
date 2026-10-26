/**
 * Sentences about getting FXM Connect that change once the signed Firefox add-on is out
 * (AVAILABLE.firefox in src/config.ts): until then the extension is a zip for Chromium
 * browsers on a computer, afterwards Firefox, on a computer or Android, installs it too.
 */

import { noExtensionPlays, otherBrowsersPlays } from './tiers'

export interface ConnectFlags {
  /** The signed Firefox add-on is out (AVAILABLE.firefox). */
  firefox: boolean
  /** The Android app is out (AVAILABLE.android). */
  android: boolean
  /**
   * The experimental Lite tier is out (AVAILABLE.lite), so the web app also plays YouTube Music
   * without FXM Connect: what it plays comes from src/lib/tiers.ts. Off when left out.
   */
  lite?: boolean
  /** The build offers Jamendo (AVAILABLE.jamendo), next to Internet Archive. Off when left out. */
  jamendo?: boolean
}

/** The fine print under the install steps of the "Get FXM" web card. */
export function installFinePrint(firefox: boolean): string {
  return firefox
    ? 'The zip is for Chrome, Edge and Brave 120 or later, on a computer. The signed add-on is for Firefox 140 or later, and for Firefox 142 or later on Android.'
    : 'For Chrome, Edge and Brave 120 or later, on a computer. A Firefox add-on is coming.'
}

/** A label of a browser's own interface, which the page shows in bold. */
export interface UiLabel {
  label: string
}

/** Firefox for Android's steps for installing the .xpi (Mozilla's steps for a file). */
export const ANDROID_INSTALL: readonly (string | UiLabel)[] = [
  'On Android (Firefox 142 or later): download the .xpi in Firefox, open ',
  { label: 'Settings → About Firefox' },
  ' and tap the Firefox logo five times. Then go back to ',
  { label: 'Settings' },
  ', tap ',
  { label: 'Install extension from file' },
  ', pick the file and tap ',
  { label: 'Add' },
  '.',
]

/** Text and labels as plain text, for tests and screen-reader checks. */
export function plainText(parts: readonly (string | UiLabel)[]): string {
  return parts.map((part) => (typeof part === 'string' ? part : part.label)).join('')
}

/** The note under the web card's buttons, for visitors who can't add FXM Connect. */
export function noExtensionNote(
  firefox: boolean,
  { lite = false, jamendo = false }: Pick<ConnectFlags, 'lite' | 'jamendo'> = {},
): string {
  const who = firefox
    ? 'No extension, or on an iPhone, an iPad or a phone browser other than Firefox?'
    : 'No extension, or on a phone or tablet?'
  return `${who} ${noExtensionPlays(lite, jamendo)}`
}

/** The FAQ's answer for phones, tablets and other browsers. */
export function phonesAnswer({
  firefox,
  android,
  lite = false,
  jamendo = false,
}: ConnectFlags): string {
  const plays = otherBrowsersPlays(lite, jamendo)
  if (!firefox) {
    return `On phones and tablets, and in other browsers such as Safari, ${plays} ${
      android
        ? 'FXM Connect needs a desktop browser; the Android app has everything built in.'
        : 'FXM Connect needs a desktop browser, and the Android app is coming soon.'
    }`
  }
  return `On Android, Firefox 142 or later can add FXM Connect too. In other phone browsers, on iPhone and iPad, and in browsers such as Safari, ${plays} ${
    android ? 'The Android app has everything built in.' : 'The Android app is coming soon.'
  }`
}

/** The privacy page's sentence on how FXM Connect is installed and who approves its permissions. */
export function privacyInstall(firefox: boolean): string {
  return firefox
    ? "In Firefox you add it as an add-on signed by Mozilla, and Firefox asks you to approve its permissions. In Chrome, Edge and Brave you install it from a zip file, so the browser doesn't ask you to approve them."
    : "You install it from a zip file, so your browser doesn't ask you to approve its permissions."
}

/**
 * Firefox looks for updates to an add-on without its own update address on addons.mozilla.org,
 * also when it was installed from a file: the privacy page says so once the add-on is out.
 */
export function privacyUpdateCheck(firefox: boolean): string {
  return firefox
    ? "Firefox checks addons.mozilla.org for updates to the FXM Connect add-on, under Mozilla's privacy policy."
    : ''
}
