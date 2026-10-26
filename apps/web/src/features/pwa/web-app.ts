import { APP_BASE } from '../../../pwa/base'

/**
 * Whether this build is the installable web app. Only the web build (base `/app/`) has the
 * manifest and the service worker. The Android and desktop builds (`build:mobile`,
 * `build:desktop`, base `/`) run from their app package, where installing FXM as a web app
 * makes no sense, so they offer no install.
 *
 * Vite replaces `import.meta.env.BASE_URL` at build time, so those builds drop the install UI.
 */
export function isInstallableWebApp(base: string = import.meta.env.BASE_URL): boolean {
  return base === APP_BASE
}
