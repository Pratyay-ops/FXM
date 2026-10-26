/**
 * The store listings of FXM Connect, for Firefox Add-ons (AMO) and Edge Add-ons, in one place.
 * The long texts live next to this file in listing/: summary.txt (AMO's summary),
 * description.md (both stores' description) and reviewer-notes.txt (AMO's notes to reviewers
 * and Edge's notes for certification).
 *
 * The release workflow sends AMO's metadata with every signed version (firefox.ts) and Edge's
 * notes with every submission (edge.ts). Edge's other fields are entered once in Partner Center:
 *
 *   pnpm --filter @fxm/extension store:listing edge [version]   prints them, ready to paste
 *   pnpm --filter @fxm/extension store:listing logo <file.png>  draws the 300 x 300 store logo
 *   pnpm --filter @fxm/extension store:listing amo <listed|unlisted> <version>
 *                                                               prints a version's AMO metadata
 *
 * Node runs this file directly (type stripping), which is why the imports spell out `.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { iconPng } from '../scripts/icons.ts'
import { EXTENSION_NAME } from '../src/config.ts'
import { buildManifest } from '../src/manifest.ts'

export const REPO_URL = 'https://github.com/Pratyay-ops/FXM'
export const SITE_URL = 'https://fxmusic.pages.dev/'
export const SUPPORT_URL = `${REPO_URL}/issues`
/** The site's privacy page has a section on FXM Connect. */
export const PRIVACY_URL = 'https://fxmusic.pages.dev/privacy#fxm-connect'

/** AMO's license slug for the repository's license (AMO API: licenses). */
export const AMO_LICENSE = 'Apache-2.0'
/** AMO category slugs for extensions (AMO API: categories), at most three. */
export const AMO_CATEGORIES = ['photos-music-videos'] as const
/** AMO's summary limit. It must not contain URLs either. */
export const AMO_SUMMARY_MAX = 250

/** Edge Add-ons category, from Partner Center's list. */
export const EDGE_CATEGORY = 'Entertainment'
/** Edge Add-ons description limits (Partner Center, "Store listings"). */
export const EDGE_DESCRIPTION_MIN = 250
export const EDGE_DESCRIPTION_MAX = 10_000
/** Size of the store logo; Edge recommends 300 x 300 and accepts 128 x 128 or more. */
export const EDGE_LOGO_SIZE = 300
/** At most 7 search terms of up to 30 characters, 21 words in all. */
export const EDGE_SEARCH_TERMS = [
  'FXM',
  'FXM Connect',
  'music player',
  'free music',
  'open source music',
] as const

/** Partner Center's "Single purpose" field. */
export const EDGE_SINGLE_PURPOSE =
  'FXM Connect lets the FXM web app at https://fxmusic.pages.dev reach the music services it ' +
  "plays from (YouTube, YouTube Music, Spotify and Last.fm) from the user's own browser. Fixed " +
  "rules adjust the CORS headers of the web app's own requests to those services. FXM Connect " +
  "also relays Spotify's public server time without cookies, and an optional bridge, off by " +
  "default, gets a Spotify token for the user's own Spotify login."

/** Why FXM Connect needs each permission and host permission of its manifest. */
export const PERMISSION_JUSTIFICATIONS: Readonly<Record<string, string>> = {
  declarativeNetRequest:
    "Applies FXM Connect's fixed header rules (rules.json, shipped with the extension). They " +
    'adjust CORS headers on the requests that the FXM web app makes to YouTube, Spotify and ' +
    'Last.fm and remove cookies from them, and they apply only to requests started by ' +
    "https://fxmusic.pages.dev. FXM Connect has no webRequest permission, so it can't see " +
    'any other traffic.',
  storage:
    "Keeps the rate-limit counter of the background's two Spotify requests (the public server " +
    'time and the optional login token) in storage.session, which lives in memory and is ' +
    'cleared when the browser closes.',
  'https://fxmusic.pages.dev/*':
    'Runs the presence content script on the FXM web app, and lets the header rules apply to ' +
    "the requests the web app starts: browsers change a request's headers only when the " +
    'extension can also access the page that started it.',
  'https://www.youtube.com/*':
    "YouTube's API (search, video details): the rules set YouTube's Origin and add CORS " +
    'headers, so the FXM web app can read the answers.',
  'https://music.youtube.com/*':
    "YouTube Music's API (search, song details, and radio for the web app's home feed and " +
    "autoplay): the rules set YouTube Music's Origin and add CORS headers, so the FXM web app " +
    'can read the answers.',
  'https://youtubei.googleapis.com/*':
    "The same YouTube API on Google's API host: the rules set a YouTube Origin and add CORS " +
    'headers.',
  'https://*.googlevideo.com/*':
    "YouTube's audio servers: the rules add CORS headers, so the FXM web app can read the " +
    'audio it plays.',
  'https://open.spotify.com/*':
    "Spotify's web-player token and server time: the rules set Spotify's Origin on these two " +
    'endpoints only. The background relays the public server time, without cookies, and the ' +
    'optional login bridge requests the token from there.',
  'https://api-partner.spotify.com/*':
    "Spotify's web-player API (search, details, and radio and recommendations for the home " +
    'feed and autoplay): the rules add CORS headers, so the FXM web app can read the answers.',
  'https://spclient.wg.spotify.com/*':
    "Spotify's web-player API (track details, and radio for the home feed and autoplay): the " +
    'rules add CORS headers, so the FXM web app can read the answers.',
  'https://www.last.fm/*':
    "Last.fm's radio stations, which the web app's home feed uses for recommendations: the rule " +
    'adds CORS headers to the station JSON only.',
}

/**
 * Partner Center's data usage section: what to tick and why. The login bridge hands the token
 * of the user's Spotify login to the FXM page, and the Chrome Web Store's categories, which
 * Edge's follow, count a login token as authentication information even though none of it
 * reaches the developer. The Firefox manifest declares the same, as optional (src/manifest.ts).
 */
export const EDGE_DATA_USAGE =
  'Tick "Authentication information" and no other data type. FXM Connect sends nothing to the ' +
  'developer. Its optional Spotify login bridge, off by default, passes the access token of ' +
  "the user's own Spotify login from open.spotify.com to the FXM web app in the same browser, " +
  'which uses it only for its requests to Spotify; where Partner Center asks why, say that. ' +
  'Tick the certifications.'

const LISTING_DIR = new URL('listing/', import.meta.url)

/** One of the listing texts in listing/, without the trailing newline. */
export function listingText(name: 'summary.txt' | 'description.md' | 'reviewer-notes.txt'): string {
  return readFileSync(new URL(name, LISTING_DIR), 'utf8').trimEnd()
}

/** Markdown as plain text, for Edge, whose description field doesn't render it. */
export function plainText(markdown: string): string {
  return markdown.replaceAll('**', '').replaceAll('`', '')
}

/** The manifest's description, which both stores show as the short description. */
export function shortDescription(): string {
  return buildManifest({ browser: 'chromium', version: '0.0.0', dev: false }).description
}

/** The notes for reviewers of one version: which release it is, then reviewer-notes.txt. */
export function reviewerNotes(version: string, commit?: string): string {
  const source = commit ? `, built from commit ${commit}` : ''
  return [
    `${EXTENSION_NAME} ${version} (FXM release v${version}${source}).`,
    `Release notes: ${REPO_URL}/releases/tag/v${version}`,
    '',
    listingText('reviewer-notes.txt'),
  ].join('\n')
}

export type AmoChannel = 'listed' | 'unlisted'

type Translated = Record<'en-US', string>

/** What `web-ext sign --amo-metadata` sends to AMO with a version. */
export interface AmoMetadata {
  categories?: string[]
  summary?: Translated
  description?: Translated
  homepage?: Translated
  support_url?: Translated
  requires_payment?: boolean
  version: {
    approval_notes: string
    license?: string
    release_notes?: Translated
  }
}

/**
 * The AMO metadata of a version. An unlisted version carries only the notes for reviewers. A
 * listed one also carries the listing, which AMO requires for the first listed version and
 * which keeps the listing in step with listing/ afterwards.
 */
export function amoMetadata(channel: AmoChannel, version: string, commit?: string): AmoMetadata {
  const approval_notes = reviewerNotes(version, commit)
  if (channel === 'unlisted') return { version: { approval_notes } }
  return {
    categories: [...AMO_CATEGORIES],
    summary: { 'en-US': listingText('summary.txt') },
    description: { 'en-US': listingText('description.md') },
    homepage: { 'en-US': SITE_URL },
    support_url: { 'en-US': SUPPORT_URL },
    requires_payment: false,
    version: {
      approval_notes,
      license: AMO_LICENSE,
      release_notes: {
        'en-US': `What changed in FXM ${version}: ${REPO_URL}/releases/tag/v${version}`,
      },
    },
  }
}

/** Every field Partner Center asks for, in its order, as text to paste. */
export function edgeListing(version: string): string {
  const manifest = buildManifest({ browser: 'chromium', version, dev: false })
  const justifications = [...manifest.permissions, ...manifest.host_permissions].map(
    (permission) => `- ${permission}: ${PERMISSION_JUSTIFICATIONS[permission] ?? '(missing)'}`,
  )
  return [
    'PROPERTIES',
    `Category: ${EDGE_CATEGORY}`,
    `Website: ${SITE_URL}`,
    `Support contact detail: ${SUPPORT_URL}`,
    'Mature content: leave unticked',
    '',
    'PRIVACY',
    `Single purpose: ${EDGE_SINGLE_PURPOSE}`,
    'Permission justification:',
    ...justifications,
    'Are you using remote code? No, I am not using remote code',
    `Data usage: ${EDGE_DATA_USAGE}`,
    `Privacy policy URL: ${PRIVACY_URL}`,
    '',
    'STORE LISTING (English)',
    `Extension name: ${manifest.name} (read from the package)`,
    `Short description: ${manifest.description} (read from the package)`,
    'Description:',
    plainText(listingText('description.md')),
    '',
    `Extension logo: draw it with "store:listing logo fxm-logo.png" (${EDGE_LOGO_SIZE} x ${EDGE_LOGO_SIZE})`,
    `Search terms: ${EDGE_SEARCH_TERMS.join(', ')}`,
    '',
    'NOTES FOR CERTIFICATION',
    reviewerNotes(version),
  ].join('\n')
}

function main(args: readonly string[]): void {
  const [command, first, second] = args
  if (command === 'amo' && (first === 'listed' || first === 'unlisted') && second) {
    process.stdout.write(`${JSON.stringify(amoMetadata(first, second), null, 2)}\n`)
  } else if (command === 'edge') {
    process.stdout.write(`${edgeListing(first ?? '0.0.0')}\n`)
  } else if (command === 'logo' && first) {
    // Relative to where the command was started, not to the package folder pnpm runs it in.
    const file = resolve(process.env.INIT_CWD ?? process.cwd(), first)
    writeFileSync(file, iconPng(EDGE_LOGO_SIZE))
    process.stdout.write(`Wrote ${file}\n`)
  } else {
    throw new Error(
      'usage: listing.ts edge [version] | logo <file.png> | amo <listed|unlisted> <version>',
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
