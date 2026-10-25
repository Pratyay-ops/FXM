/**
 * The web app manifest: what browsers need to install FXM as an app with its own window.
 *
 * @module
 */

import type { ManifestOptions } from 'vite-plugin-pwa'
import { APP_BASE } from './base.ts'
import { ICON_FILES } from './icons.ts'

export { APP_BASE }

/** The app's name: `APP_NAME` in @fxm/core, which config code can't import (a test compares). */
export const APP_TITLE = 'FXM'

/**
 * The dark theme's page background, `--color-background` in src/styles/tokens.css (a test
 * keeps them in step). It colours the splash screen and the title bar until the page sets its
 * own theme colour, which follows the theme setting.
 */
export const BACKGROUND_COLOR = '#0b0b0f'

/**
 * The manifest for an app served from `base`.
 *
 * - `id` names the installed app. Browsers use it to recognise an installation, so it must
 *   never change once FXM is published.
 * - `display_override` asks for Window Controls Overlay on desktop, where the page's top bar
 *   is the title bar (src/features/pwa/title-bar.ts); everywhere else it is a standalone window.
 * - `launch_handler` focuses the open window instead of starting a second player, and hands it
 *   the launch URL (src/features/pwa/launch-queue.ts), so the music keeps playing.
 */
export function webManifest(base: string = APP_BASE): Partial<ManifestOptions> {
  return {
    id: base,
    name: APP_TITLE,
    short_name: APP_TITLE,
    description: 'A free, open-source music player: search and play practically any song.',
    lang: 'en',
    dir: 'ltr',
    start_url: base,
    scope: base,
    display: 'standalone',
    display_override: ['window-controls-overlay'],
    background_color: BACKGROUND_COLOR,
    theme_color: BACKGROUND_COLOR,
    categories: ['music', 'entertainment'],
    prefer_related_applications: false,
    launch_handler: { client_mode: ['focus-existing', 'auto'] },
    icons: ICON_FILES.filter((icon) => icon.variant !== 'square').map((icon) => ({
      src: icon.file,
      sizes: `${icon.size}x${icon.size}`,
      type: 'image/png',
      purpose: icon.variant,
    })),
    // Shown in the app icon's menu (right-click on desktop, long press on Android).
    shortcuts: [
      { name: 'Search', url: `${base}search` },
      { name: 'Your library', short_name: 'Library', url: `${base}library` },
    ],
  }
}
