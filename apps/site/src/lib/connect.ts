/**
 * Sentences about getting FXM Connect that change once the signed Firefox add-on is out
 * (AVAILABLE.firefox in src/config.ts): until then the extension is a zip for Chromium
 * browsers on a computer, afterwards Firefox, on a computer or Android, installs it too.
 */

export interface ConnectFlags {
  /** The signed Firefox add-on is out (AVAILABLE.firefox). */
  firefox: boolean
  /** The Android app is out (AVAILABLE.android). */
  android: boolean
}

/** The fine print under the install steps of the "Get FXM" web card. */
export function installFinePrint(firefox: boolean): string {
  return firefox
    ? 'The zip is for Chrome, Edge and Brave 120 or later, on a computer. The signed add-on is for Firefox 140 or later, and for Firefox 142 or later on Android.'
    : 'For Chrome, Edge and Brave 120 or later, on a computer. A Firefox add-on is coming.'
}

/** Where Firefox for Android hides "Install extension from file" (Mozilla's steps). */
export const ANDROID_INSTALL_NOTE =
  'On Android, Firefox shows Install extension from file in its settings after you tap the Firefox logo five times in Settings → About Firefox.'

/** The FAQ's answer for phones, tablets and other browsers. */
export function phonesAnswer({ firefox, android }: ConnectFlags): string {
  if (!firefox) {
    return `On phones and tablets, and in other browsers such as Safari, the web app plays free music from Internet Archive and Jamendo. ${
      android
        ? 'FXM Connect needs a desktop browser; the Android app has everything built in.'
        : 'FXM Connect needs a desktop browser, and the Android app is coming soon.'
    }`
  }
  return `On Android, Firefox can add FXM Connect too. In other phone browsers, on iPhone and iPad, and in browsers such as Safari, the web app plays free music from Internet Archive and Jamendo. ${
    android ? 'The Android app has everything built in.' : 'The Android app is coming soon.'
  }`
}

/** The privacy page's sentence on how FXM Connect is installed and who approves its permissions. */
export function privacyInstall(firefox: boolean): string {
  return firefox
    ? "In Firefox you add it as an add-on signed by Mozilla, and Firefox asks you to approve its permissions. In Chrome, Edge and Brave you install it from a zip file, so the browser doesn't ask you to approve them."
    : "You install it from a zip file, so your browser doesn't ask you to approve its permissions."
}
