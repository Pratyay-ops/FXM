/**
 * Manifest V3 for Chromium-based browsers and Firefox, generated from config.ts and rules.ts.
 */
import { EXTENSION_NAME, fxmOrigins } from './config.ts'
import { originMatchPattern } from './origins.ts'
import { buildRulesets, ruleHostPermissions } from './rules.ts'

/** Browser families the build targets. */
export type Browser = 'chromium' | 'firefox'

/** Gecko add-on ID (needed for storage and signing on AMO). */
export const FIREFOX_ADDON_ID = 'fxm-connect@fxmusic.pages.dev'

/**
 * Oldest Firefox that runs FXM Connect. MV3 declarativeNetRequest arrived in 113,
 * `storage.session` in 115, and `data_collection_permissions` (required for new AMO listings)
 * in 140.
 */
export const FIREFOX_MIN_VERSION = '140.0'

/**
 * Oldest Firefox for Android that runs FXM Connect: `data_collection_permissions` arrived there in
 * 142. Declaring `gecko_android` also tells AMO that the add-on works on Android, so its listing
 * offers it there.
 */
export const FIREFOX_ANDROID_MIN_VERSION = '142.0'

/**
 * Oldest Chromium that runs FXM Connect. `initiatorDomains`/`requestDomains` arrived in 101 and
 * `storage.session` in 102; 120 is a conservative floor with every feature used here.
 */
export const CHROMIUM_MIN_VERSION = '120'

/** Icon sizes shipped in `icons/icon-<size>.png`. */
export const ICON_SIZES = [16, 32, 48, 128] as const

/** Chrome Web Store limit for the description. */
export const MAX_DESCRIPTION_LENGTH = 132

const PURPOSE = 'Only lets the FXM web app reach music services from your own browser.'
const DESCRIPTION = `${PURPOSE} Collects no data and runs no remote code.`
const DEV_DESCRIPTION = `Development build: also allows localhost. ${PURPOSE}`

/**
 * Whether both browsers accept a version: one to four dot-separated integers from 0 to 65535,
 * without leading zeros. Prerelease labels such as `0.2.0-beta.1` are refused.
 */
export function isExtensionVersion(version: string): boolean {
  if (!/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(version)) return false
  return version.split('.').every((part) => Number(part) <= 65535)
}

/** The `version` of a parsed package.json. Throws unless both browsers accept it. */
export function packageVersion(pkg: unknown): string {
  const version =
    typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined
  if (typeof version !== 'string' || !isExtensionVersion(version)) {
    throw new Error(
      `package.json needs a version Chrome and Firefox accept (1 to 4 dot-separated integers up to 65535), got ${JSON.stringify(version)}`,
    )
  }
  return version
}

/**
 * Content security policy of the options page and the background. MV3's default only restricts
 * scripts; this one also limits styles and images to FXM Connect's own files and lets them
 * connect to open.spotify.com only, the one host the Spotify bridge fetches from.
 */
export const EXTENSION_PAGES_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  'connect-src https://open.spotify.com',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** Permissions besides host access: static header rules and the options toggle. */
export const PERMISSIONS = ['declarativeNetRequest', 'storage'] as const

export interface ManifestOptions {
  browser: Browser
  version: string
  /** Development build: also allows the localhost FXM origins. */
  dev: boolean
}

type IconMap = Record<`${(typeof ICON_SIZES)[number]}`, string>

/** The fields FXM Connect writes; key order matches the generated file. */
export interface Manifest {
  manifest_version: 3
  name: string
  version: string
  description: string
  icons: IconMap
  action: { default_title: string; default_icon: Partial<IconMap> }
  background: { service_worker: string } | { scripts: string[] }
  content_scripts: {
    matches: string[]
    js: string[]
    run_at: 'document_start'
    all_frames: false
  }[]
  options_ui: { page: string; open_in_tab: true }
  content_security_policy: { extension_pages: string }
  permissions: string[]
  host_permissions: string[]
  declarative_net_request: {
    rule_resources: { id: string; enabled: boolean; path: string }[]
  }
  minimum_chrome_version?: string
  browser_specific_settings?: {
    gecko: {
      id: string
      strict_min_version: string
      data_collection_permissions: { required: ['none'] }
    }
    gecko_android: { strict_min_version: string }
  }
}

/**
 * host_permissions: the FXM pages first, then the services. DNR modifies headers only when the
 * extension has host access to the request's initiator too, and the FXM entries must stay
 * exact-host patterns (never `*.`): DNR's initiatorDomains also matches sub-domains, so this
 * host access is what keeps the rules away from pages such as preview deployments at
 * <hash>.fxmusic.pages.dev.
 */
export function hostPermissions(origins: readonly string[]): string[] {
  return [...new Set([...origins.map(originMatchPattern), ...ruleHostPermissions()])]
}

function icons(sizes: readonly number[]): Record<string, string> {
  return Object.fromEntries(sizes.map((size) => [String(size), `icons/icon-${size}.png`]))
}

/** Builds manifest.json for one browser and variant. */
export function buildManifest({ browser, version, dev }: ManifestOptions): Manifest {
  if (!isExtensionVersion(version)) throw new Error(`not a valid extension version: ${version}`)
  const origins = fxmOrigins(dev)
  const matches = [...new Set(origins.map(originMatchPattern))]
  const name = dev ? `${EXTENSION_NAME} (dev)` : EXTENSION_NAME
  return {
    manifest_version: 3,
    name,
    version,
    description: dev ? DEV_DESCRIPTION : DESCRIPTION,
    icons: icons(ICON_SIZES) as IconMap,
    action: { default_title: name, default_icon: icons([16, 32]) },
    background:
      browser === 'chromium' ? { service_worker: 'background.js' } : { scripts: ['background.js'] },
    content_scripts: [{ matches, js: ['content.js'], run_at: 'document_start', all_frames: false }],
    options_ui: { page: 'options.html', open_in_tab: true },
    content_security_policy: { extension_pages: EXTENSION_PAGES_CSP },
    permissions: [...PERMISSIONS],
    host_permissions: hostPermissions(origins),
    declarative_net_request: {
      rule_resources: buildRulesets(origins).map(({ id, enabled, path }) => ({
        id,
        enabled,
        path,
      })),
    },
    ...(browser === 'chromium'
      ? { minimum_chrome_version: CHROMIUM_MIN_VERSION }
      : {
          browser_specific_settings: {
            gecko: {
              id: FIREFOX_ADDON_ID,
              strict_min_version: FIREFOX_MIN_VERSION,
              data_collection_permissions: { required: ['none'] },
            },
            gecko_android: { strict_min_version: FIREFOX_ANDROID_MIN_VERSION },
          },
        }),
  }
}
