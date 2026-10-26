/**
 * The names of saved files: "Artist - Title.ext", safe on Windows, macOS, Linux and Android.
 *
 * @module
 */

import type { ExportTags } from './types'

/** Characters no file system takes in a name, and control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"/\\|?*]/g
/** Names Windows reserves for devices, whatever the extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
/** Most file systems allow 255 bytes per name; this leaves room for an extension and a "(2)". */
const MAX_NAME_LENGTH = 150

/** `text` made safe as part of a file name. */
function clean(text: string): string {
  return text.normalize('NFC').replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The file name for a saved track: "Artist A, Artist B - Title.ext", or "Title.ext" without
 * artists, "FXM download.ext" without either. Characters file systems refuse become spaces,
 * and the name is cut to 150 characters.
 */
export function exportFileName(
  tags: Pick<ExportTags, 'title' | 'artists'>,
  extension: string,
): string {
  const artists = clean(tags.artists.filter((artist) => artist.trim() !== '').join(', '))
  const title = clean(tags.title)
  let base = artists && title ? `${artists} - ${title}` : title || artists || 'FXM download'
  if (base.length > MAX_NAME_LENGTH) base = base.slice(0, MAX_NAME_LENGTH).trim()
  // No leading or trailing dots (hidden files, Windows trims them), no device names.
  base = base.replace(/^\.+/, '').replace(/[. ]+$/, '') || 'FXM download'
  if (DEVICE_NAME.test(base)) base = `${base} (track)`
  const safeExtension = extension.replace(/[^A-Za-z0-9]/g, '')
  return safeExtension ? `${base}.${safeExtension}` : base
}
