/**
 * The names of saved files: "Artist - Title.ext", safe on Windows, macOS, Linux and Android.
 *
 * @module
 */

import type { ExportTags } from './types'

/** Characters no file system takes in a name, and control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"/\\|?*]/g
/** Half of a surrogate pair without its other half, which no file system can store. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
/** Names Windows reserves for devices, whatever the extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
/**
 * The longest name before the extension, in bytes of UTF-8. ext4, f2fs, APFS and Android's
 * storage allow 255 bytes per name, NTFS and exFAT 255 UTF-16 units (never more units than a
 * name has UTF-8 bytes), so this leaves room for the extension and a " (2)".
 */
export const MAX_NAME_BYTES = 200

const encoder = new TextEncoder()

/** `text` made safe as part of a file name. */
function clean(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .normalize('NFC')
    .replace(LONE_SURROGATE, '')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The characters of `text` as a reader sees them: grapheme clusters, or code points. */
function characters(text: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(text), (part) => part.segment)
  }
  return Array.from(text)
}

/** `text` cut to at most `maxBytes` bytes of UTF-8, between whole characters. */
function cutToBytes(text: string, maxBytes: number): string {
  if (encoder.encode(text).length <= maxBytes) return text
  let cut = ''
  let bytes = 0
  for (const character of characters(text)) {
    bytes += encoder.encode(character).length
    if (bytes > maxBytes) break
    cut += character
  }
  return cut
}

/**
 * The file name for a saved track: "Artist A, Artist B - Title.ext", or "Title.ext" without
 * artists, "FXM download.ext" without either. Characters file systems refuse become spaces,
 * and the name before the extension is cut to {@link MAX_NAME_BYTES} bytes of UTF-8, between
 * whole characters (an emoji or an accented letter is never split).
 */
export function exportFileName(
  tags: Pick<ExportTags, 'title' | 'artists'>,
  extension: string,
): string {
  const named = (Array.isArray(tags.artists) ? tags.artists : []).map(clean).filter(Boolean)
  const artists = named.join(', ')
  const title = clean(tags.title)
  let base = artists && title ? `${artists} - ${title}` : title || artists || 'FXM download'
  base = cutToBytes(base, MAX_NAME_BYTES).trim()
  // No leading or trailing dots (hidden files, Windows trims them), no device names.
  base = base.replace(/^\.+/, '').replace(/[. ]+$/, '') || 'FXM download'
  if (DEVICE_NAME.test(base)) base = `${base} (track)`
  const safeExtension = extension.replace(/[^A-Za-z0-9]/g, '')
  return safeExtension ? `${base}.${safeExtension}` : base
}
