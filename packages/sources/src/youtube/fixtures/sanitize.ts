/**
 * Sanitizing recorded InnerTube responses before they become fixtures. A response can carry the
 * recording machine's IP address (in `initplayback` and stream URLs, often percent-encoded, and
 * in `sw.js_data`), its visitorData and tracking tokens, and commenters' names and texts. The
 * sanitizer keeps the catalog data the parsers read and drops or replaces everything else:
 *
 * - tracking and logging fields, accessibility labels, styling, `frameworkUpdates`,
 *   `responseContext` (apart from a visitorData, which becomes {@link FAKE_VISITOR_DATA}) and
 *   `microformat` (apart from its title and canonical URL);
 * - every menu item but "View song credits", like buttons and dialogs, and every
 *   `watchEndpointSupportedOnesieConfig`;
 * - every IPv4 or IPv6 address, written plainly or percent-encoded, IPv6 also compressed (`::`),
 *   and the value of every `ip=` URL parameter: replaced with an address from the documentation
 *   ranges, {@link DOC_IPV4} or {@link DOC_IPV6};
 * - long texts, cut to {@link MAX_TEXT} characters.
 *
 * {@link truncateItems} then keeps long lists short.
 *
 * @module
 */

/** The visitorData every fixture carries instead of a real one. */
export const FAKE_VISITOR_DATA = 'CgtGWE1fZml4dHVyZSiAgICAgICAgIAB'

/** Longest text kept in a fixture. */
export const MAX_TEXT = 240

const DROPPED_KEYS = new Set([
  'accessibility',
  'accessibilityData',
  'accessibilityPauseData',
  'accessibilityPlayData',
  'activeBackgroundColor',
  'activeScaleFactor',
  'adSlots',
  'annotations',
  'aspectRatio',
  'attestation',
  'avatar',
  'background',
  'backgroundColor',
  'buttonSize',
  'cards',
  'channelThumbnailSupportedRenderers',
  'chipBar',
  'chipCloudRenderer',
  'clickTrackingParams',
  'collapsedItemCount',
  'contentPosition',
  'contentsMultiSelectable',
  'customIndexColumn',
  'defaultIcon',
  'detailedMetadataSnippets',
  'displayPriority',
  'displayStyle',
  'engagementPanels',
  'expandableMetadata',
  'flexColumnDisplayStyle',
  'frameworkUpdates',
  'headerStyle',
  'iconColor',
  'iconLoadingColor',
  'inlinePlaybackEndpoint',
  'itemHeight',
  'itemPlayback',
  'likeButtonRenderer',
  'loadingIndicatorColor',
  'loggingContext',
  'loggingDirectives',
  'modalEndpoint',
  'moreButton',
  'multiSelectCheckbox',
  'pauseIcon',
  'playerParams',
  'playlistSetVideoId',
  'playIcon',
  'playerOverlays',
  'playingIcon',
  'queueContextParams',
  'queueNavigationEndpoint',
  'rendererContext',
  'responseId',
  'richThumbnail',
  'rippleTarget',
  'searchHeaderRenderer',
  'searchVideoResultEntityKey',
  'serializedContextData',
  'serializedShareEntity',
  'serviceTrackingParams',
  'shareEndpoint',
  'shareEntityEndpoint',
  'shelfDivider',
  'shuffleToggleButton',
  'size',
  'storyboards',
  'styleRuns',
  'subHeaderChipCloud',
  'subscriptionButton',
  'thumbnailCrop',
  'thumbnailOverlay',
  'thumbnailOverlays',
  'thumbnailScale',
  'toggledIcon',
  'topLevelButtons',
  'topbar',
  'trackingParams',
  'videoReporting',
  'voteSortValue',
  'watchEndpointSupportedOnesieConfig',
])

/** The IPv4 address every fixture carries instead of a real one (RFC 5737). */
export const DOC_IPV4 = '192.0.2.1'

/** The IPv6 address every fixture carries instead of a real one (RFC 3849). */
export const DOC_IPV6 = '2001:db8::1'

/** One group of an IPv6 address, and the separator of the groups, plain or percent-encoded. */
const HEX = '[0-9a-f]{1,4}'
const COLON = '(?::|%3a)'

/**
 * An IPv4 address, its dots plain or percent-encoded. It may follow a percent escape
 * (`ip%3D106%2E…`), but not stand inside a longer number or word, such as a version.
 */
export const IPV4 = /(?<![\d.])(?:\d{1,3}(?:\.|%2e)){3}\d{1,3}(?![\w.])/giu

/**
 * An IPv6 address: eight groups, or fewer around one `::`, the colons plain or percent-encoded.
 * Without a `::` it needs at least three colons, so times such as `1:02:03` never match.
 */
export const IPV6 = new RegExp(
  `(?:${HEX}${COLON}){7}${HEX}|(?:${HEX}${COLON}){1,6}${COLON}(?:${HEX}(?:${COLON}${HEX}){0,5})?|(?:${HEX}${COLON}){3,6}${HEX}`,
  'giu',
)

/**
 * The value of an `ip` URL parameter, plain or percent-encoded (`&ip=…`, `%3Fip%3D…`), up to the
 * next parameter.
 */
const IP_PARAMETER = /((?:[?&]|%3f|%26)ip(?:=|%3d))(?:(?!%26)[^&"\s])*/giu

function scrub(text: string): string {
  return text.replace(IP_PARAMETER, `$1${DOC_IPV4}`).replace(IPV6, DOC_IPV6).replace(IPV4, DOC_IPV4)
}

/** Whether a menu item is the "View song credits" link (`MPTC<videoId>`), the one FXM reads. */
function isCredits(item: unknown): boolean {
  const browse = (
    item as { menuNavigationItemRenderer?: { navigationEndpoint?: { browseEndpoint?: object } } }
  ).menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint as
    | { browseId?: unknown }
    | undefined
  return typeof browse?.browseId === 'string' && browse.browseId.startsWith('MPTC')
}

function isMenuItem(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false
  return Object.keys(item).some((name) => /^(?:menu|toggleMenu)/u.test(name))
}

function sanitizeValue(value: unknown, key: string | undefined): unknown {
  if (typeof value === 'string') {
    if (key === 'visitorData') return FAKE_VISITOR_DATA
    const scrubbed = scrub(value)
    return scrubbed.length > MAX_TEXT && (key === 'text' || key === 'content')
      ? `${scrubbed.slice(0, MAX_TEXT)}…`
      : scrubbed
  }
  if (Array.isArray(value)) {
    const kept =
      key === 'items' ? value.filter((item) => !isMenuItem(item) || isCredits(item)) : value
    return kept.map((item) => sanitizeValue(item, undefined))
  }
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_KEYS.has(name)) continue
    if (name === 'responseContext') {
      const visitorData = (child as { visitorData?: unknown } | null)?.visitorData
      if (typeof visitorData === 'string') out[name] = { visitorData: FAKE_VISITOR_DATA }
      continue
    }
    if (name === 'microformat') {
      const data = (child as { microformatDataRenderer?: Record<string, unknown> } | null)
        ?.microformatDataRenderer
      const kept = Object.fromEntries(
        ['title', 'urlCanonical'].flatMap((field) =>
          typeof data?.[field] === 'string' ? [[field, data[field]]] : [],
        ),
      )
      out[name] = { microformatDataRenderer: kept }
      continue
    }
    if (name === 'commandMetadata') {
      const pageType = (child as { webCommandMetadata?: { webPageType?: unknown } } | null)
        ?.webCommandMetadata?.webPageType
      if (typeof pageType === 'string')
        out[name] = { webCommandMetadata: { webPageType: pageType } }
      continue
    }
    out[name] = sanitizeValue(child, name)
  }
  return out
}

/** A sanitized deep copy of a recorded response (see the module documentation). */
export function sanitizeResponse(json: unknown): unknown {
  return sanitizeValue(json, undefined)
}

/** The item renderers whose lists {@link truncateItems} shortens. */
const ITEM_RENDERERS = new Set([
  'musicResponsiveListItemRenderer',
  'musicTwoRowItemRenderer',
  'playlistPanelVideoRenderer',
  'playlistPanelVideoWrapperRenderer',
  'videoRenderer',
  'channelRenderer',
  'lockupViewModel',
])

function isItem(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).some((name) => ITEM_RENDERERS.has(name))
  )
}

/**
 * Keeps only the first `count` items of every list of items (rows, cards, queue items, search
 * results), plus a continuation item at its end, so that a long page stays small while its shape
 * and its continuation stay as they are. Other lists, such as the sections of a page, are kept
 * whole.
 */
export function truncateItems(json: unknown, count: number): unknown {
  if (Array.isArray(json)) {
    if (json.length > count && json.some(isItem)) {
      const last = json.at(-1) as Record<string, unknown> | undefined
      const continuation = last !== undefined && 'continuationItemRenderer' in last ? [last] : []
      return [...json.slice(0, count), ...continuation].map((item) => truncateItems(item, count))
    }
    return json.map((item) => truncateItems(item, count))
  }
  if (typeof json !== 'object' || json === null) return json
  return Object.fromEntries(
    Object.entries(json as Record<string, unknown>).map(([name, child]) => [
      name,
      truncateItems(child, count),
    ]),
  )
}

/**
 * How many items each fixture keeps per list (see {@link truncateItems}): enough for the tests,
 * few enough for git. Album pages and their audio playlists stay whole, so their rows line up.
 */
export const KEPT_ITEMS: Readonly<Record<string, number>> = {
  'search-songs': 10,
  'search-songs-2': 6,
  'search-videos': 10,
  'search-albums': 6,
  'search-artists': 6,
  'search-playlists': 6,
  'web-search-videos': 8,
  'web-search-channels': 5,
  'web-search-playlists': 3,
  'artist-radiohead': 4,
  'channel-uploader': 4,
  'playlist-b-sides': 8,
  'playlist-popular': 5,
  'playlist-popular-2': 5,
  'radio-creep': 12,
  'radio-creep-2': 10,
  'radio-artist': 8,
}
