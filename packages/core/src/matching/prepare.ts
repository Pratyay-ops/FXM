/**
 * Turns titles, artist names and album names into what the matching engine compares, using the
 * core text helpers in their documented order: presentation noise out, a known "Artist - "
 * prefix out, `splitTitle`, version tags from the qualifiers and the album (never from the title
 * proper), `normalizeText` on the core.
 *
 * @module
 */

import {
  extractVersionTags,
  normalizeText,
  splitTitle,
  stripPresentationNoise,
  type VersionTags,
} from '../text'
import { containsWords, diceSimilarity, textTokens } from './similarity'

/** How far apart two versions of a song are, as `extractVersionTags` grades them. */
export type VersionLevel = keyof VersionTags

/** A version tag's place among the others (see {@link VERSION_TAGS}). */
interface TagKind {
  /** The kind of version it names, e.g. `live` for "unplugged". */
  family: string
  /** Whether it names one version of that kind (`unplugged`), not only the kind (`live`). */
  specific: boolean
}

/**
 * Version tags that name a kind of version another tag also names, by family. A family's
 * generic tags name the kind only ("live", "concert"); its specific tags name one version of
 * that kind ("unplugged", "Tiny Desk", "take 3"). A generic tag is matched by any tag of its
 * family on the other side, so "(Live)" against an unplugged album is not a mismatch; a specific
 * tag only by the same tag, so "Tiny Desk" against "Live", "Take 2" against "Take 3" and "Club
 * Mix" against "VIP Mix" are. Tags not listed are a family of their own, and generic.
 */
const VERSION_TAGS: Readonly<Record<string, TagKind>> = {
  live: { family: 'live', specific: false },
  concert: { family: 'live', specific: false },
  performance: { family: 'live', specific: false },
  unplugged: { family: 'live', specific: true },
  'tiny desk': { family: 'live', specific: true },
  session: { family: 'live', specific: true },
  tour: { family: 'live', specific: true },
  festival: { family: 'live', specific: true },
  remix: { family: 'remix', specific: false },
  rework: { family: 'remix', specific: false },
  bootleg: { family: 'remix', specific: false },
  'club mix': { family: 'remix', specific: true },
  'dub mix': { family: 'remix', specific: true },
  'vip mix': { family: 'remix', specific: true },
  extended: { family: 'extended', specific: false },
  '12" version': { family: 'extended', specific: true },
  cover: { family: 'cover', specific: false },
  tribute: { family: 'cover', specific: false },
  'originally performed by': { family: 'cover', specific: false },
  'in the style of': { family: 'cover', specific: false },
  'made famous by': { family: 'cover', specific: false },
  karaoke: { family: 'cover', specific: true },
  instrumental: { family: 'instrumental', specific: false },
  'backing track': { family: 'instrumental', specific: false },
  'minus one': { family: 'instrumental', specific: false },
  'off vocal': { family: 'instrumental', specific: false },
  acoustic: { family: 'acoustic', specific: false },
  stripped: { family: 'acoustic', specific: true },
  'piano version': { family: 'acoustic', specific: true },
  orchestral: { family: 'orchestral', specific: false },
  symphonic: { family: 'orchestral', specific: false },
  'sped up': { family: 'sped up', specific: false },
  nightcore: { family: 'sped up', specific: true },
  slowed: { family: 'slowed', specific: false },
  reverb: { family: 'slowed', specific: false },
  daycore: { family: 'slowed', specific: true },
  chopped: { family: 'chopped', specific: false },
  screwed: { family: 'chopped', specific: false },
  demo: { family: 'demo', specific: false },
  rehearsal: { family: 'demo', specific: true },
  outtake: { family: 'demo', specific: true },
  'alternate take': { family: 'demo', specific: true },
  'early version': { family: 'demo', specific: true },
  're-recorded': { family: 're-recorded', specific: false },
  "taylor's version": { family: 're-recorded', specific: true },
  'recorded at': { family: 're-recorded', specific: true },
  // A radio edit and a single version are usually the same edit; the duration tells them apart
  // when they are not. The other edits are edits of their own.
  edit: { family: 'edit', specific: false },
  'radio edit': { family: 'edit', specific: false },
  'single edit': { family: 'edit', specific: false },
  'short edit': { family: 'edit', specific: true },
  'clean edit': { family: 'edit', specific: true },
  'video edit': { family: 'edit', specific: true },
  'tv edit': { family: 'edit', specific: true },
  'tv size': { family: 'edit', specific: true },
}

/** The family of a version tag and whether it is specific, e.g. `demo`, specific, for "take 3". */
export function tagKind(tag: string): TagKind {
  if (Object.hasOwn(VERSION_TAGS, tag)) {
    const kind = VERSION_TAGS[tag]
    if (kind !== undefined) return kind
  }
  if (/^take \d+$/u.test(tag)) return { family: 'demo', specific: true }
  return { family: tag, specific: false }
}

/**
 * Whether a version tag of one title is matched by the tags of another: by the same tag, or, for
 * a generic tag, by any tag of its family (see {@link VERSION_TAGS}).
 */
export function versionCovered(tag: string, others: ReadonlyMap<string, VersionLevel>): boolean {
  if (others.has(tag)) return true
  const { family, specific } = tagKind(tag)
  if (specific) return false
  for (const other of others.keys()) if (tagKind(other).family === family) return true
  return false
}

/** Whether any tag is of the remix family ("Remix", "Club Mix", "Rework"…). */
export function hasRemixTag(versions: ReadonlyMap<string, VersionLevel>): boolean {
  for (const tag of versions.keys()) if (tagKind(tag).family === 'remix') return true
  return false
}

/** The version tags in a text, each with its level (the strongest wins). */
function versionTags(text: string): Map<string, VersionLevel> {
  const tags = new Map<string, VersionLevel>()
  if (text.trim() === '') return tags
  const found = extractVersionTags(text)
  for (const level of ['strong', 'medium', 'soft'] as const) {
    for (const tag of found[level]) if (!tags.has(tag)) tags.set(tag, level)
  }
  return tags
}

/**
 * Tags whose words also name studio albums: "Magical Mystery Tour", "Sessions", "Stripped",
 * "Performance and Cocktails". An album's name carries them only in a bracket or a dash suffix
 * ("Hotel California (Live)"), or when its name reads as a live recording ({@link LIVE_ALBUM}).
 */
const ALBUM_TITLE_TAGS: ReadonlySet<string> = new Set([
  'tour',
  'festival',
  'session',
  'stripped',
  'performance',
])

/** An album name that reads as a live recording: "Live", "Live 2003", "Live at Wembley"… */
const LIVE_ALBUM =
  /^live(?: \d{4}(?!\p{N}).*)?$|(?:^|\s)live (?:at|in|from|on|@)\s|^(?:recorded|performed) live(?:\s|$)/u

/**
 * "Live" in an album's name that is not a live recording: a name that starts with "Live" and
 * another word ("Live Through This", "Live Forever"), and "Long Live" ("LONG.LIVE.A$AP").
 * Elsewhere ("Hysteria Live", "Live 2003") an album's "Live" counts.
 */
const NOT_LIVE_ALBUM =
  /^live (?!(?:at|in|from|on|for|with|@)\s|\d)|(?:^|[^\p{L}\p{N}])long[\s.]+live(?![\p{L}\p{N}])/u

/**
 * The version tags of an album name: every tag in its brackets and dash suffixes, and those of
 * its name proper except the words that also name studio albums ({@link ALBUM_TITLE_TAGS},
 * {@link NOT_LIVE_ALBUM}), unless the name reads as a live recording. So "MTV Unplugged in New
 * York" and "Live 2003" are live, while "Magical Mystery Tour (Remastered)" is only remastered
 * and "Live Through This" is nothing.
 */
export function albumVersionTags(album: string): Map<string, VersionLevel> {
  const parts = splitTitle(normalizeText(stripPresentationNoise(album)))
  const tags = versionTags(parts.qualifiers.map(normalizeText).join(' | '))
  const core = normalizeText(parts.core)
  const live = LIVE_ALBUM.test(core)
  for (const [tag, level] of versionTags(core)) {
    if (!live && ALBUM_TITLE_TAGS.has(tag)) continue
    if (!live && tag === 'live' && NOT_LIVE_ALBUM.test(core)) continue
    if (!tags.has(tag)) tags.set(tag, level)
  }
  return tags
}

/**
 * Words that say "remix" without naming whose: what is left names the remixer, plus the kind of
 * mix ("club", "vip", "dub"), which tells mixes by the same remixer apart.
 */
const REMIX_WORDS =
  /(?<![\p{L}\p{N}])(?:re-?mix(?:es|ed)?|rmx|mix|edit|version|extended|radio|original|official|feat|ft|featuring|by|the|re-?work(?:ed)?|bootleg|refix)(?![\p{L}\p{N}])/gu

/** A title prepared for comparison. Every string is normalized. */
export interface PreparedTitle {
  /** The title proper, e.g. `song` for "Song (feat. X) - Live". */
  core: string
  /** The qualifiers, e.g. `['live']`. */
  qualifiers: string[]
  /** Featured artists named in the title. */
  featured: string[]
  /** Version tags found in the qualifiers and the album, each with its level. */
  versions: ReadonlyMap<string, VersionLevel>
  /**
   * For a remix: the words of its qualifiers that name it, such as `cedric gervais` for "Cedric
   * Gervais Remix" or `club` for "Club Mix". Empty when there is no remix or it is not named.
   */
  remixDetail: string
}

/** Opening and closing quotes that set a title off after an artist name. */
const QUOTED_TITLE = /^(.+?)(?:\s*「(.+?)」|\s*『(.+?)』|\s+'(.+?)'|\s+"(.+?)")(.*)$/u

/** "Artist - Title", "Artist | Title" or "Artist ~ Title". */
const DASHED_TITLE = /^(.+?)\s+[-|~]\s+(.+)$/u

/** Separators between the names of a credit: "A, B & C", "A x B", "A feat. B". */
const NAME_SEPARATORS =
  /\s*(?:,|、|・|&|\+|\/|\s(?:and|x|×|vs\.?|feat\.?|ft\.?|featuring|with)\s)\s*/u

/** Bracketed parts of a name, such as "(방탄소년단)" or "(CV: Akina)". */
const NAME_BRACKETS = /\s*(?:\([^)]*\)|\[[^\]]*\]|（[^）]*）)\s*/gu

/**
 * A channel or artist name as the engine compares it: normalized, without bracketed parts and
 * without the channel decorations " - Topic", "VEVO" and "Official".
 */
export function cleanArtistName(name: string): string {
  return normalizeText(name)
    .replace(NAME_BRACKETS, ' ')
    .replace(/\s*-\s*topic$/u, '')
    .replace(/\s*vevo$/u, '')
    .replace(/(?<![\p{L}\p{N}])official(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** The separate names in one credit: "Luis Fonsi & Daddy Yankee" → both names. */
export function splitArtistNames(name: string): string[] {
  return cleanArtistName(name)
    .split(NAME_SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** Without a leading "the". */
function withoutArticle(name: string): string {
  return name.replace(/^the\s+/u, '')
}

/**
 * Whether the cleaned artist name `name` is found as `other`: equal (a leading "The" aside), Dice
 * on character bigrams of at least 0.8 ("Everly Brothers" and "Every Brothers"), or `other`
 * containing `name` as whole words when `name` has two words or more ("Jeff Buckley" in "Jeff
 * Buckley Music"). Containment runs one way only, and never for a one-word name: "Bill Haley" is
 * not "Bill Haley & His Comets", and "Queen" is not "Queen Naija".
 */
export function sameArtist(name: string, other: string): boolean {
  if (name === '' || other === '') return false
  if (withoutArticle(name) === withoutArticle(other)) return true
  if (diceSimilarity(name, other) >= 0.8) return true
  return textTokens(name).length >= 2 && containsWords(other, name)
}

/** Every name a credit list offers for matching: each credit, and each name within it. */
function namePool(credits: readonly string[]): string[] {
  const pool = new Set<string>()
  for (const credit of credits) {
    const clean = cleanArtistName(credit)
    if (clean !== '') pool.add(clean)
    for (const part of splitArtistNames(credit)) pool.add(part)
  }
  return [...pool]
}

/** Whether `name` is found as any name of the pool (see {@link sameArtist}). */
function inPool(name: string, pool: readonly string[]): boolean {
  return pool.some((other) => sameArtist(name, other))
}

/**
 * The share of the source's artists found among a candidate's, from 0 to 1. A source credit
 * counts fully when it is found among the candidate's names (see {@link sameArtist}); otherwise,
 * a credit that joins several names ("Bill Haley & His Comets") counts by the share of its names
 * found. The candidate's names include featured artists named in its title.
 */
export function artistSimilarity(
  sourceArtists: readonly string[],
  candidateArtists: readonly string[],
): number {
  const credits = sourceArtists.map(cleanArtistName).filter((name) => name !== '')
  if (credits.length === 0) return 0
  const pool = namePool(candidateArtists)
  if (pool.length === 0) return 0
  let found = 0
  for (const credit of credits) {
    if (inPool(credit, pool)) {
      found += 1
      continue
    }
    const parts = splitArtistNames(credit)
    if (parts.length > 1) found += parts.filter((part) => inPool(part, pool)).length / parts.length
  }
  return found / credits.length
}

/** Whether every name of `credit` matches one of `artists` ("BTS (방탄소년단)" → BTS). */
function isArtistCredit(credit: string, artists: readonly string[]): boolean {
  const names = splitArtistNames(credit)
  const pool = namePool(artists)
  return names.length > 0 && names.every((name) => inPool(name, pool))
}

/**
 * Whether `name` is among `credits`: as a whole, or name by name when it joins several ("Sia &
 * Diplo"). Used to tell a featured artist the source credits from one it does not.
 */
export function isCredited(name: string, credits: readonly string[]): boolean {
  const pool = namePool(credits)
  const clean = cleanArtistName(name)
  if (clean !== '' && inPool(clean, pool)) return true
  const names = splitArtistNames(name)
  return names.length > 1 && names.every((part) => inPool(part, pool))
}

/**
 * Removes a leading credit of known artists from a title: "The Weeknd - Blinding Lights",
 * "Luis Fonsi, Daddy Yankee - Despacito", "YOASOBI「アイドル」", "BTS (방탄소년단) 'Dynamite'".
 * Whatever follows a quoted title becomes a bracketed qualifier: "Artist 'Song' Remix" reads as
 * "Song (Remix)". The title comes back as it was when nothing before the separator is a known
 * artist. Case is kept, so it serves search queries too.
 */
export function stripArtistPrefix(title: string, artists: readonly string[]): string {
  if (artists.length === 0) return title
  const quoted = QUOTED_TITLE.exec(title)
  if (quoted) {
    const inner = (quoted[2] ?? quoted[3] ?? quoted[4] ?? quoted[5] ?? '').trim()
    const rest = (quoted[6] ?? '').trim()
    if (inner !== '' && isArtistCredit(quoted[1] ?? '', artists)) {
      return rest === '' ? inner : `${inner} (${rest})`
    }
  }
  const dashed = DASHED_TITLE.exec(title)
  if (dashed && isArtistCredit(dashed[1] ?? '', artists)) return (dashed[2] ?? '').trim()
  return title
}

/**
 * Prepares a title for comparison:
 *
 * 1. `stripPresentationNoise`, then `normalizeText`
 * 2. a leading credit of `artists` goes ({@link stripArtistPrefix}), so "Artist - Stripped"
 *    keeps "Stripped" as its title
 * 3. `splitTitle` gives the core, the qualifiers and featured artists
 * 4. version tags come from the qualifiers and from `album` ({@link albumVersionTags}), never
 *    from the core, so "Live Forever" is not live while a track of "MTV Unplugged in New York" is
 */
export function prepareTitle(
  title: string,
  artists: readonly string[] = [],
  album?: string,
): PreparedTitle {
  const parts = splitTitle(stripArtistPrefix(normalizeText(stripPresentationNoise(title)), artists))
  const qualifiers = parts.qualifiers.map(normalizeText)
  const versions = versionTags(qualifiers.join(' | '))
  if (album !== undefined) {
    for (const [tag, level] of albumVersionTags(album)) {
      if (!versions.has(tag)) versions.set(tag, level)
    }
  }
  const remixDetail = qualifiers
    .filter((qualifier) => hasRemixTag(versionTags(qualifier)))
    .map((qualifier) => qualifier.replace(REMIX_WORDS, ' '))
    .join(' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return {
    core: normalizeText(parts.core),
    qualifiers,
    featured: parts.featured.map(normalizeText),
    versions,
    remixDetail,
  }
}

/** The forms of classical works, which a number, a key or a catalogue number follows. */
const CLASSICAL_FORMS =
  'symphon(?:y|ie|ies)|sinfonia|concerto|concertino|sonata|sonatina|suite|partita|prelude|praeludium|fugue|nocturne|etude|mazurka|polonaise|waltz|valse|cantata|requiem|mass|oratorio|overture|toccata|fantasia|impromptu|ballade|scherzo|rondo|serenade|divertimento|quartet|quintet|trio|bagatelle|intermezzo|invention|caprice|capriccio|minuet|menuet|menuett'

/**
 * What only classical works carry in their titles: a catalogue number ("BWV 1007", "Op. 27",
 * "K. 525"), a key ("in C-sharp minor"), a form with a number or a key ("Symphony No. 5",
 * "Prelude in C") or a numbered movement (": I. Prélude"). A form word alone is not enough:
 * "Symphony", "Prelude", "Suite: Judy Blue Eyes" and "Adagio for Strings" are popular titles too.
 */
const CLASSICAL = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}])(?:bwv|kv|hwv|op|opus|hob|rv|woo|sz|k\.|d\.)\s*\.?\s*\d+`,
    String.raw`(?<![\p{L}\p{N}])in\s+[a-g](?:[\s-](?:flat|sharp))?[\s-](?:major|minor|dur|moll)(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])(?:${CLASSICAL_FORMS})e?s?\s+(?:no\.?|nr\.?|n°|number)\s*\d+`,
    String.raw`(?<![\p{L}\p{N}])(?:${CLASSICAL_FORMS})e?s?\s+in\s+[a-g](?:[\s-](?:flat|sharp)|[#♭♯])?(?![\p{L}\p{N}])`,
    String.raw`:\s*[ivx]+\.\s`,
  ].join('|'),
  'u',
)

/**
 * Whether a title looks like a classical work ("Cello Suite No. 1 in G Major, BWV 1007: I.
 * Prélude"), whose title alone fits many recordings by many performers.
 */
export function isClassicalTitle(title: string): boolean {
  return CLASSICAL.test(normalizeText(title))
}
