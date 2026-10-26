import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The FXM Android app: the web app (apps/web) in a Capacitor WebView. `make apk` builds it,
 * see "Android app" in docs/DEVELOPMENT.md. Run `make apk` after changing this file:
 * `cap sync` copies it into the native project.
 */
const config: CapacitorConfig = {
  appId: 'io.github.pratyayops.fxm',
  appName: 'FXM',
  // The web app built with base '/' (`build:mobile` in apps/web): the WebView serves it from
  // https://localhost/, so the router's basename is '/' instead of the web's '/app/'.
  webDir: '../web/dist-mobile',
  // The dark theme's --color-background (apps/web/src/styles/tokens.css), shown until the
  // page paints, so the app never flashes white.
  backgroundColor: '#0b0b0f',
  // No bridge logging, also not in debug builds: Capacitor would log every plugin result to the
  // console and from there to logcat, including FxmHttp's response bodies (Spotify tokens among
  // them). Debug the WebView with chrome://inspect instead.
  loggingBehavior: 'none',
  plugins: {
    // Keep Capacitor's global fetch/XHR patch off: it drops the Cookie, Origin and Referer
    // headers and corrupts binary bodies, and sends WebView cookies. The web app's fetch is the
    // FxmHttp plugin (android/fxm-http), which @fxm/platform uses on Android. This setting leaves
    // the CapacitorHttp plugin itself callable, so MainActivity replaces it with one that refuses.
    CapacitorHttp: { enabled: false },
    SystemBars: {
      // The web app uses viewport-fit=cover and pads its bars with env(safe-area-inset-*),
      // so it needs no injected CSS variables.
      insetsHandling: 'native',
      initialViewportFitValueHint: 'cover',
      // Light status and navigation bar icons for the dark theme, whatever the system theme.
      style: 'DARK',
    },
  },
}

export default config
