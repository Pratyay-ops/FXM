/**
 * Where the third-party notices of the build in use are, for Settings → About and the
 * converter's credit.
 *
 * @module
 */

import { APP_BASE } from '../../pwa/base'

/** The site's third-party notices, as FXM's own site serves them. */
export const PUBLIC_NOTICES_URL = 'https://fxmusic.pages.dev/third-party-notices.txt'

/**
 * Where the third-party notices of this build are: at the root of the deploy that serves the web
 * app (its `/app/` build: production, a preview, a copy self-hosted from the release's web zip,
 * each with the notices of what it ships), else on FXM's own site (the desktop and Android
 * builds, served from `/`). They name every bundled package with its licence, and every part of
 * the ffmpeg core with its licence, its source and how to replace it (tools/ffmpeg-wasm).
 */
export function noticesUrl(base: string = import.meta.env.BASE_URL): string {
  return base === APP_BASE ? '/third-party-notices.txt' : PUBLIC_NOTICES_URL
}
