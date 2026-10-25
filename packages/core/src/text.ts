/**
 * Text helpers for matching titles across sources: normalization, title splitting, removal of
 * presentation noise and version tags. The matching engine builds on them.
 *
 * They are heuristics, so they work best when composed in this order:
 * `stripPresentationNoise` → remove a leading "Artist - " when the artist is known →
 * `splitTitle` → `extractVersionTags` on the qualifiers → `normalizeText` on the core.
 *
 * @module
 */

// --- Shared building blocks -----------------------------------------------------------------

/** Not preceded by a letter, digit or combining mark of any script. */
const BEFORE = String.raw`(?<![\p{L}\p{N}\p{M}])`
/** Not followed by a letter, digit or combining mark of any script. */
const AFTER = String.raw`(?![\p{L}\p{N}\p{M}])`

/** `re` as whole words: never inside a longer run of letters or digits ("live" ≠ "Alive"). */
function words(re: RegExp, flags = 'gu'): RegExp {
  return new RegExp(`${BEFORE}(?:${re.source})${AFTER}`, flags)
}

/** NFC, collapsed whitespace, trimmed. */
function tidy(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/** Separators and dangling punctuation left at either end after removing parts of a title. */
const EDGE_PUNCTUATION =
  /^[-\s\u2013\u2014~|\uFF5C:\uFF1A/\u00B7\u2022,]+|[-\s\u2013\u2014~|\uFF5C:\uFF1A/\u00B7\u2022,]+$/gu

// --- normalizeText --------------------------------------------------------------------------

/** Characters that render as nothing: soft hyphen, zero-width space, word joiner, BOM. */
const INVISIBLE = /[\u00AD\u200B\u2060\uFEFF]/gu
/** Typographic apostrophes and single quotation marks. */
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u2035\u2039\u203A\u02B9\u02BB\u02BC]/gu
/** Typographic double quotation marks. */
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u00AB\u00BB\u301D\u301E\u301F]/gu
/** Unicode hyphens, dashes and the minus sign (not the Japanese long vowel mark ー). */
const DASHES = /[\u2010-\u2015\u2043\u2212\u2E3A\u2E3B\uFE58\uFE63]/gu
/** Combining marks on a Latin letter, once decomposed. Marks on other scripts stay. */
const LATIN_MARKS = /(\p{Script=Latin})\p{M}+/gu
/** Latin letters with a stroke, and ligatures, which have no decomposition to strip. */
const LATIN_FOLDS: Readonly<Record<string, string>> = {
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ħ: 'h',
  ı: 'i',
  ł: 'l',
  ŧ: 't',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  þ: 'th',
}
const LATIN_FOLD_LETTERS = /[øđðħıłŧßæœþ]/gu

/**
 * Normalizes text for comparison (never for display):
 *
 * - Unicode NFKC, so full-width letters, ligatures and compatibility forms become plain ones
 * - lower case
 * - typographic quotes and apostrophes become `'` and `"`, Unicode dashes become `-`, and the
 *   wave dash 〜 becomes `~` (sources mix it up with the full-width tilde)
 * - diacritics are removed from Latin letters only (`Beyoncé` → `beyonce`, `Mø` → `mo`);
 *   CJK, Devanagari, Cyrillic, Greek and every other script stay intact (`й` stays `й`)
 * - invisible characters are removed and whitespace runs collapse to one space, trimmed
 *
 * Punctuation is otherwise kept.
 */
export function normalizeText(text: string): string {
  return (
    text
      // Acute and grave accents typed as apostrophes; NFKC would split ´ into a space and a mark.
      .replace(/[\u00B4`]/gu, "'")
      .normalize('NFKC')
      .toLowerCase()
      .replace(INVISIBLE, '')
      .replace(SINGLE_QUOTES, "'")
      .replace(DOUBLE_QUOTES, '"')
      .replace(DASHES, '-')
      .replace(/\u301C/gu, '~')
      .normalize('NFD')
      .replace(LATIN_MARKS, '$1')
      .replace(LATIN_FOLD_LETTERS, (letter) => LATIN_FOLDS[letter] ?? letter)
      .normalize('NFC')
      .replace(/\s+/gu, ' ')
      .trim()
  )
}

// --- extractVersionTags ---------------------------------------------------------------------

/**
 * Version tags found in a title, as canonical lower-case names (e.g. `remaster` for
 * "Remastered 2011", `sped up` for "Speed Up"), each listed once, in order of appearance.
 */
export interface VersionTags {
  /** A different recording or performance: live, remix, cover, acoustic, sped up, demo... */
  strong: string[]
  /** A different edit of the same recording: radio edit, single version, TV size... */
  medium: string[]
  /** The same recording, mastered or mixed differently: remaster, mono, Dolby Atmos... */
  soft: string[]
}

type TagLevel = keyof VersionTags

interface TagRule {
  level: TagLevel
  tag: string | ((match: RegExpMatchArray) => string)
  re: RegExp
}

/** Katakana, plus the prolonged sound mark ー, which is Script=Common but only written in kana. */
const KATAKANA = String.raw`[\p{Script=Katakana}\u{30FC}]`
/** Hangul syllables and letters. */
const HANGUL = String.raw`\p{Script=Hangul}`

/**
 * Katakana words that may touch a katakana tag word in one run of katakana: the tag words and a
 * few words that keep the meaning, such as "version", "song" and "studio". Any other katakana
 * next to a tag word makes it part of another word: "ドライブ" (drive) is not "ライブ" (live), and
 * "ディスカバー" (discover) is not "カバー" (cover).
 */
const KANA_NEIGHBORS = [
  'ライブ',
  'カバー',
  'リミックス',
  'カラオケ',
  'インストゥルメンタル',
  'インスト',
  'アコースティック',
  'オフボーカル',
  'バージョン',
  'ヴァージョン',
  'ソング',
  'ツアー',
  'ビデオ',
  'スタジオ',
  'オンライン',
].join('|')

/** The same for Hangul: "드라이브" (drive) is not "라이브" (live), but "커버곡" is a cover song. */
const HANGUL_NEIGHBORS = [
  '라이브',
  '커버',
  '리믹스',
  '노래방',
  '어쿠스틱',
  '버전',
  '곡',
  '영상',
].join('|')

/** Before a katakana tag word: no katakana, unless it ends a neighboring word. */
const KANA_BEFORE = `(?:(?<!${KATAKANA})|(?<=${KANA_NEIGHBORS}))`
/** After a katakana tag word: no katakana, unless it starts a neighboring word. */
const KANA_AFTER = `(?:(?!${KATAKANA})|(?=${KANA_NEIGHBORS}))`

/** Where a tag pattern may start and end. */
type Boundary = 'word' | 'katakana' | 'hangul' | 'none'

const BOUNDARIES: Readonly<Record<Boundary, readonly [before: string, after: string]>> = {
  // Whole words of any script: "live" is not in "Alive".
  word: [BEFORE, AFTER],
  // Whole katakana words: Han, hiragana, punctuation and other scripts may touch them, as in
  // "ライブ映像" (live footage), but other katakana may not, except a neighboring word.
  katakana: [KANA_BEFORE, KANA_AFTER],
  // Whole Hangul words, with the same exception.
  hangul: [
    `(?:(?<!${HANGUL})|(?<=${HANGUL_NEIGHBORS}))`,
    `(?:(?!${HANGUL})|(?=${HANGUL_NEIGHBORS}))`,
  ],
  // The pattern brings its own boundaries, or needs none (distinctive Han phrases).
  none: ['', ''],
}

/** A tag rule whose pattern only matches between the given boundaries. */
function rule(
  level: TagLevel,
  tag: TagRule['tag'],
  re: RegExp,
  boundary: Boundary = 'word',
): TagRule {
  const [before, after] = BOUNDARIES[boundary]
  return { level, tag, re: new RegExp(`${before}(?:${re.source})${after}`, 'gu') }
}

const LANGUAGES = [
  'english',
  'spanish',
  'french',
  'german',
  'italian',
  'portuguese',
  'japanese',
  'korean',
  'chinese',
  'mandarin',
  'cantonese',
  'hindi',
  'tamil',
  'telugu',
  'punjabi',
  'bengali',
  'arabic',
  'russian',
  'turkish',
  'indonesian',
  'thai',
  'vietnamese',
  'tagalog',
  'filipino',
  'polish',
  'dutch',
  'swedish',
  'greek',
  'eng',
  'jp',
  'kr',
  'cn',
].join('|')

/** Abbreviations and Spanish, French and Portuguese spellings of the language names. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  eng: 'english',
  jp: 'japanese',
  kr: 'korean',
  cn: 'chinese',
  espanol: 'spanish',
  ingles: 'english',
  frances: 'french',
  francais: 'french',
  francaise: 'french',
  portugues: 'portuguese',
  italiano: 'italian',
  aleman: 'german',
}

function languageVersion(match: RegExpMatchArray): string {
  const name = match[1] ?? ''
  return `${LANGUAGE_NAMES[name] ?? name} version`
}

/**
 * Tag rules in priority order: a later rule never matches text an earlier one claimed, so
 * "Radio Edit" is `radio edit` and not also `edit`. Patterns see normalized text.
 */
const TAG_RULES: readonly TagRule[] = [
  // Strong, several words.
  rule('strong', 'originally performed by', /originally performed by/u),
  rule('strong', 'in the style of', /in the style of/u),
  rule('strong', 'made famous by', /(?:as )?made famous by/u),
  rule('strong', 'tiny desk', /tiny desk(?: concerts?)?/u),
  rule('strong', 'backing track', /backing tracks?/u),
  rule('strong', 'minus one', /minus (?:one|1)/u),
  rule('strong', 'off vocal', /off[- ]?vocals?/u),
  rule('strong', 'off vocal', /オフボーカル/u, 'katakana'),
  rule('strong', 'piano version', /piano (?:version|ver\.?|edition|arrangement)/u),
  rule('strong', 'alternate take', /alt(?:ernat(?:e|ive))?\.? (?:take|version)/u),
  rule('strong', 'early version', /early (?:version|take)/u),
  rule('strong', "taylor's version", /taylor'?s version/u),
  rule(
    'strong',
    languageVersion,
    new RegExp(String.raw`(${LANGUAGES})(?: language)? (?:version|ver\.?)`, 'u'),
  ),
  rule(
    'strong',
    languageVersion,
    /version (?:en )?(espanol|ingles|frances|francais|francaise|portugues|italiano|aleman)/u,
  ),
  rule('strong', 'club mix', /club (?:mix|edit|version)/u),
  rule('strong', 'dub mix', /dub (?:mix|version)/u),
  rule('strong', 'vip mix', /vip(?: (?:mix|edit))?/u),
  rule(
    'strong',
    '12" version',
    /12(?:"|''| ?inch(?:es)?|in\.?)(?: (?:version|mix|remix|single))?/u,
  ),
  rule('strong', 'bass boosted', /bass[- ]?boost(?:ed)?/u),
  rule('strong', 'sped up', /(?:sped|speed|speeded)[- ]?up/u),
  rule('strong', (match) => `take ${Number(match[1])}`, /take (\d+)/u),
  rule('strong', 'acapella', /a ?capp?ella|vocals? only/u),
  rule('strong', 'mashup', /mash[- ]?up/u),
  rule('strong', 're-recorded', /re-? ?record(?:ed|ing)?/u),
  // Medium, several words.
  rule('medium', 'radio edit', /radio (?:edit|version)/u),
  rule('medium', 'single edit', /single (?:edit|version)/u),
  rule('medium', 'short edit', /short (?:edit|version|ver\.?)|shortened(?: version)?/u),
  rule('medium', 'clean edit', /clean (?:edit|version)/u),
  rule('medium', 'video edit', /video (?:edit|version)/u),
  rule('medium', 'tv edit', /tv (?:edit|version|ver\.?)/u),
  rule('medium', 'tv size', /(?:tv|anime)[- ]?size/u),
  rule('medium', 'tv size', new RegExp(`${BEFORE}tv ?サイズ${KANA_AFTER}`, 'u'), 'none'),
  rule('medium', 'tv size', /アニメ ?サイズ/u, 'katakana'),
  // Strong, one word.
  rule('strong', 'live', /live(?:stream)?|en vivo|ao vivo|en directo/u),
  rule('strong', 'live', /ライブ/u, 'katakana'),
  rule('strong', 'live', /라이브/u, 'hangul'),
  rule('strong', 'live', /@(?=\s+\S)/u),
  rule('strong', 'unplugged', /unplugged/u),
  rule('strong', 'concert', /concerts?/u),
  rule('strong', 'tour', /tours?/u),
  rule(
    'strong',
    'festival',
    /festivals?|coachella|glastonbury|lollapalooza|tomorrowland|woodstock|rock in rio|primavera sound/u,
  ),
  rule('strong', 'session', /sessions?/u),
  rule('strong', 'performance', /performs|performing|performance/u),
  rule('strong', 'remix', /remix(?:e[sd])?|rmx|re-mix/u),
  rule('strong', 'remix', /リミックス/u, 'katakana'),
  rule('strong', 'remix', /리믹스/u, 'hangul'),
  rule('strong', 'rework', /re-?work(?:ed)?|refix/u),
  rule('strong', 'bootleg', /bootleg/u),
  rule('strong', 'extended', /extended(?! play)(?: (?:mix|version|edit|cut))?/u),
  rule('strong', 'cover', /cover version|covered by|covers?|кавер/u),
  rule('strong', 'cover', /カバー/u, 'katakana'),
  rule('strong', 'cover', /커버/u, 'hangul'),
  // "Tried singing it", the usual title of a cover; "歌ってみたい" (want to try) is not one.
  rule('strong', 'cover', /歌ってみた(?!\p{Script=Hiragana})|翻唱/u, 'none'),
  rule('strong', 'karaoke', /karaoke/u),
  rule('strong', 'karaoke', /カラオケ/u, 'katakana'),
  rule('strong', 'karaoke', /노래방/u, 'hangul'),
  rule('strong', 'karaoke', /卡拉ok/u, 'none'),
  rule('strong', 'tribute', /tribute/u),
  rule('strong', 'instrumental', /instrumentals?|inst\.?/u),
  rule('strong', 'instrumental', /インストゥルメンタル|インスト/u, 'katakana'),
  rule('strong', 'instrumental', /伴奏/u, 'none'),
  rule('strong', 'acoustic', /acoustic|acustic[oa]/u),
  rule('strong', 'acoustic', /アコースティック/u, 'katakana'),
  rule('strong', 'acoustic', /어쿠스틱/u, 'hangul'),
  rule('strong', 'stripped', /stripped(?: (?:back|down))?/u),
  rule('strong', 'orchestral', /orchestral/u),
  rule('strong', 'symphonic', /symphonic/u),
  rule('strong', 'slowed', /slowed(?: down)?/u),
  rule('strong', 'reverb', /reverb(?:ed)?/u),
  rule('strong', 'nightcore', /nightcore/u),
  rule('strong', '8d', /8d(?: audio)?/u),
  rule('strong', 'daycore', /daycore/u),
  rule('strong', 'lo-fi', /lo[- ]?fi/u),
  rule('strong', 'chopped', /chopped/u),
  rule('strong', 'screwed', /screwed/u),
  rule('strong', 'demo', /demos?/u),
  rule('strong', 'rehearsal', /rehearsals?/u),
  rule('strong', 'outtake', /outtakes?/u),
  rule('strong', 'medley', /medley/u),
  rule('strong', 'reprise', /reprise/u),
  // Soft.
  rule('soft', 'remaster', /(?:\d{4} )?(?:digital(?:ly)? )?re-?master(?:ed|ing)?(?: \d{4})?/u),
  rule('soft', 'anniversary', /(?:\d+(?:st|nd|rd|th) )?anniversary(?: edition)?/u),
  rule('soft', 'deluxe', /deluxe(?: (?:edition|version))?/u),
  rule('soft', 'mono', /mono(?: (?:version|mix))?/u),
  rule('soft', 'stereo', /stereo(?: (?:version|mix))?/u),
  rule('soft', 'dolby atmos', /(?:dolby )?atmos/u),
  rule('soft', 'spatial', /spatial(?: audio)?/u),
  // Medium, one word: last, so every longer edit phrase wins.
  rule('medium', 'edit', /edit(?:ed)?/u),
]

/**
 * Finds version tags in `text` (case-insensitive, whole words, after {@link normalizeText}),
 * in three classes:
 *
 * - **strong**, a different recording or performance: live, unplugged, concert, tour,
 *   festival, session(s), performs/performance, "@ <show>", Tiny Desk, remix, rework, bootleg,
 *   club/dub/VIP mix, extended, 12" version, cover, karaoke, tribute, "originally performed
 *   by", "in the style of", "made famous by", backing track, instrumental, "minus one", "off
 *   vocal", acoustic, stripped, "piano version", orchestral, symphonic, "sped up"/"speed up",
 *   slowed, reverb, nightcore, 8D, "bass boosted", daycore, lo-fi, chopped, screwed, demo,
 *   rehearsal, outtake, "alternate take", "take N", "early version", "Taylor's Version",
 *   re-recorded, "<language> version"; also a cappella, mashup, medley and reprise, and common
 *   Japanese, Korean, Chinese, Spanish and Portuguese words for live, cover, remix, karaoke,
 *   instrumental and acoustic
 * - **medium**, a different edit: radio/single/short/clean/video/TV edit or version, edit,
 *   shortened, "anime size", "TV size"
 * - **soft**, the same recording mastered differently: remaster(ed), "YYYY remaster",
 *   anniversary, deluxe, mono, stereo, Dolby Atmos, spatial
 *
 * Words only count as whole words, so "Alive" is not live, "Coverage" not cover and
 * "Demonstration" not demo. Katakana and Hangul words must be whole words of their script too:
 * "ドライブ" (drive) is not live and "ディスカバー" (discover) not cover, while "ライブ映像" (live
 * footage) and "アコースティックライブ" (acoustic live) count. Pass the qualifiers from
 * {@link splitTitle} rather than a whole title when you can: words of the title proper count too
 * ("Live Forever" has `live`).
 */
export function extractVersionTags(text: string): VersionTags {
  const normalized = normalizeText(text)
  const claimed: Array<readonly [number, number]> = []
  const found: Array<{ at: number; level: TagLevel; tag: string }> = []
  for (const { level, tag, re } of TAG_RULES) {
    // The shared global regex is reused through exec: matchAll would clone it on every call,
    // which made this function several times slower. Nothing here can run in between.
    re.lastIndex = 0
    for (let match = re.exec(normalized); match !== null; match = re.exec(normalized)) {
      const start = match.index
      const end = start + match[0].length
      if (end === start) {
        // No rule matches empty text, but never loop forever if one ever does.
        re.lastIndex = end + 1
        continue
      }
      if (claimed.some(([from, to]) => start < to && end > from)) continue
      claimed.push([start, end])
      found.push({ at: start, level, tag: typeof tag === 'string' ? tag : tag(match) })
    }
  }
  found.sort((a, b) => a.at - b.at)
  const tags: VersionTags = { strong: [], medium: [], soft: [] }
  for (const { level, tag } of found) {
    if (!tags[level].includes(tag)) tags[level].push(tag)
  }
  return tags
}

function hasVersionTag(text: string): boolean {
  const { strong, medium, soft } = extractVersionTags(text)
  return strong.length + medium.length + soft.length > 0
}

// --- stripPresentationNoise -----------------------------------------------------------------

/** Phrases that are presentation noise wherever they appear. */
const NOISE_PHRASES = words(
  new RegExp(
    [
      String.raw`official\s+(?:(?:music|lyrics?|hd|hq|4k|animated|visual)\s+)?(?:video|audio|visuali[sz]er|mv|m/v|clip|videoclip)`,
      String.raw`(?:music|lyrics?)\s+video`,
      String.raw`(?:v[ií]deo\s*clipe?|v[ií]deo|[aá]udio|clipe?)\s+oficial`,
      String.raw`full\s+(?:video|audio)(?:\s+song)?|full\s+song|(?:video|audio)\s+song|lyrical\s+video`,
      String.raw`(?:with|w/)\s+lyrics|con\s+letra`,
    ].join('|'),
    'u',
  ),
  'giu',
)

/** Words that are noise when they make up a whole bracketed group, e.g. "(Audio)" or "[Clean]". */
const GROUP_NOISE = words(
  /official|oficial|music|v[ií]deo|[aá]udio|lyrics?|lyrical|letras?|lirik|tradu[cç](?:[aã]o|ci[oó]n)|translation|translated|legendad[oa]|subtitled|subtitles|visuali[sz]er|mv|m\/v|hd|hq|4k|explicit|clean|(?:un)?censored|full|clip|videoclip/u,
  'giu',
)

/**
 * Words that are noise when they make up a whole " - " or " | " segment. Narrower than
 * {@link GROUP_NOISE}: "Taylor Swift - Clean" and "LSD - Audio" are song titles.
 */
const SEGMENT_NOISE = words(
  /lyrics?|lyrical|letras?|lirik|tradu[cç](?:[aã]o|ci[oó]n)|translation|legendad[oa]|visuali[sz]er|mv|m\/v|hd|hq|4k/u,
  'giu',
)

/** Joining words that do not change whether a group is noise: "(Lyrics and Translation)". */
const FILLER = words(/and|with|e|y|con/u, 'giu')

/** A bracketed group without nested brackets of its own kind. */
const NOISE_GROUP =
  /\(([^()]*)\)|\[([^[\]]*)\]|\{([^{}]*)\}|（([^（）]*)）|［([^［］]*)］|【([^【】]*)】|〖([^〖〗]*)〗/gu

/** Separators between the parts of a video title, kept by `split`. */
const NOISE_SEPARATOR = /(\s+[-\u2013\u2014~](?=\s)|\s*[|\uFF5C]\s*|\s+\/\/(?=\s))/u

/** A "Lyrical:" or "MV |" label in front of the title. */
const LEADING_LABEL = /^(?:lyrical|lyrics?|letra|mv|m\/v)\s*[-:\uFF1A|\uFF5C]\s*/iu

/** Unambiguous noise words at the very end, after a space: "Song Lyrics", "Song HD". */
const TRAILING_NOISE = /(?:\s+(?:lyrics?|letra|lirik|hd|hq|4k|mv|m\/v))+$/iu

/** Whether `text` holds nothing but noise phrases, `tokens`, joining words and punctuation. */
function isOnlyNoise(text: string, tokens: RegExp): boolean {
  const rest = text.replace(NOISE_PHRASES, ' ').replace(tokens, ' ').replace(FILLER, ' ')
  return /^[\s\p{P}\p{S}]*$/u.test(rest)
}

/**
 * Removes the " - " and " | " segments of `text` that are pure noise or empty. Each kept segment
 * keeps the separator in front of it; `text` comes back untouched when nothing goes.
 */
function dropNoiseSegments(text: string): string {
  const parts = text.split(NOISE_SEPARATOR)
  const kept: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const segment = (parts[i] ?? '').trim()
    if (segment === '' || isOnlyNoise(segment, SEGMENT_NOISE)) continue
    kept.push(kept.length === 0 ? segment : `${(parts[i - 1] ?? '').trim()} ${segment}`)
  }
  return kept.length === (parts.length + 1) / 2 ? text : kept.join(' ')
}

/**
 * Removes presentation noise from a title, keeping everything that tells recordings apart:
 * "official (music) video/audio", "lyric(s)" / "lyric video", "visualizer", "MV" / "M/V",
 * "audio", "HD" / "HQ" / "4K", "letra", "tradução" / "traducao", "lirik" and "explicit" /
 * "clean", plus a few close variants ("video oficial", "full video song").
 *
 * Phrases such as "Official Music Video" go wherever they are. Single words go only when they
 * make up a whole bracketed group ("Song (Audio)"), a whole " - " / " | " segment ("Song |
 * Lyrics"), or, for the unambiguous ones, the end of the title ("Song HD"), so titles like
 * "Clean" or "Audio" survive. Version information stays: "Song (Official Live Video)" keeps its
 * group because "Live" matters. The result keeps the original case; if nothing would be left,
 * the original title comes back (with whitespace tidied).
 */
export function stripPresentationNoise(title: string): string {
  const original = tidy(title)
  let text = original.replace(NOISE_PHRASES, ' ')
  // Twice, so a group that only held a removed group goes too: "(Official Video (HD))".
  for (let pass = 0; pass < 2; pass++) {
    text = text.replace(NOISE_GROUP, (group: string, ...captures: unknown[]) => {
      // One of the seven bracket captures took part; the others are undefined.
      const content = captures.slice(0, 7).find((capture) => typeof capture === 'string')
      return isOnlyNoise(String(content ?? ''), GROUP_NOISE) ? ' ' : group
    })
  }
  text = dropNoiseSegments(text).replace(LEADING_LABEL, '').replace(TRAILING_NOISE, '')
  text = tidy(text).replace(EDGE_PUNCTUATION, '')
  return text === '' ? original : text
}

// --- splitTitle -----------------------------------------------------------------------------

/** The parts of a title, as returned by {@link splitTitle}. */
export interface TitleParts {
  /** The title proper, in its original case, e.g. `Song` for "Song (feat. X) - Live". */
  core: string
  /** Bracketed groups and version suffixes, in order, without their brackets or dash. */
  qualifiers: string[]
  /** Featured artists' names, in order. */
  featured: string[]
}

const BRACKET_PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '（': '）',
  '［': '］',
  '【': '】',
  '〖': '〗',
}

interface BracketGroup {
  start: number
  end: number
  content: string
}

/** The index of the bracket closing the one at `open`, or -1 when it never closes. */
function closingIndex(text: string, open: number): number {
  const expected: string[] = []
  for (let i = open; i < text.length; i++) {
    const char = text.charAt(i)
    const closer = BRACKET_PAIRS[char]
    if (closer !== undefined) {
      expected.push(closer)
    } else if (char === expected.at(-1)) {
      expected.pop()
      if (expected.length === 0) return i
    }
  }
  return -1
}

/** Top-level bracketed groups, nesting allowed. An opener that never closes stays text. */
function findGroups(text: string): BracketGroup[] {
  const groups: BracketGroup[] = []
  for (let i = 0; i < text.length; i++) {
    if (BRACKET_PAIRS[text.charAt(i)] === undefined) continue
    const close = closingIndex(text, i)
    if (close < 0) continue
    groups.push({ start: i, end: close + 1, content: text.slice(i + 1, close) })
    i = close
  }
  return groups
}

const FEAT_MARKER = String.raw`(?:featuring|feat|ft)${AFTER}\.?`
/** "feat. X", "ft X", "featuring X" or "with X" opening a group or suffix. */
const FEAT_START = new RegExp(String.raw`^(?:${FEAT_MARKER}|with(?=\s))\s*`, 'iu')
/** "feat. X", "ft X" or "featuring X" opening a " - " suffix ("with" is too common there). */
const FEAT_LEAD = new RegExp(String.raw`^${FEAT_MARKER}\s*`, 'iu')
/** "feat. X" inside a group: "(Remix feat. X)". */
const FEAT_INSIDE = new RegExp(String.raw`\s${FEAT_MARKER}\s*`, 'iu')
/** "feat X", "feat. X", "ft. X" or "featuring X" outside brackets; "ft" needs its dot there. */
const FEAT_INLINE = new RegExp(String.raw`(?:^|\s)(?:featuring|feat${AFTER}\.?|ft\.)\s*`, 'iu')
/** Separators between featured names: "A, B & C", "A and B", "A x B". */
const NAME_SEPARATOR = /\s*(?:,|、|&|\s(?:and|x|×)\s)\s*/iu
/** " - ", " – " or " — " between parts of a title. */
const DASH_SEPARATOR = /\s+[-\u2013\u2014](?=\s)/gu
/** Where a run of unbracketed featured names ends. */
const NAMES_END = /\s+[-\u2013\u2014|](?=\s)/u
/** A separator repeated after the part between two of them was removed: "Song - - Artist". */
const REPEATED_DASH = /(\s[-\u2013\u2014])(?:\s[-\u2013\u2014])+(?=\s|$)/gu
/** A trailing "~Short Ver.~" or "〜Remix〜" group, common in Japanese titles. */
const TILDE_GROUP = /[~\u301C\uFF5E]([^~\u301C\uFF5E]+)[~\u301C\uFF5E]\s*$/u

/** Dash suffixes that mark a version, matched against the normalized suffix. */
const VERSION_SUFFIX = new RegExp(
  `^(?:${[
    String.raw`(?:recorded |performed )?live(?: (?:at|in|from|on|for|with|@)${AFTER}.*| version| session| edit| recording| \d{4})?`,
    `from (?:["'「『]|the (?:motion picture|original|film|movie|series|tv|anime|video game|soundtrack|musical)${AFTER}).*`,
    String.raw`(?:prod\.?|produced) (?:by )?.+`,
    String.raw`.*?${BEFORE}(?:remix(?:e[sd])?|rmx|mix|edit|version|ver\.?|rework|refix|bootleg|dub|vip|mashup|medley|demo|instrumental|acoustic|karaoke|unplugged|sessions?|take \d+|bonus track|a ?capp?ella|reprise|mono|stereo|re-?master(?:ed)?(?: \d{4})?|sped up|speed up|slowed(?: down)?|reverb|nightcore|8d(?: audio)?|lo-?fi|stripped|extended|edition|(?:dolby )?atmos|spatial audio|(?:tv|anime) size)`,
  ].join('|')})$`,
  'u',
)

function splitNames(text: string): string[] {
  return text
    .split(NAME_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

/** The featured names in a group's content, and any qualifier text before them. */
function featuredIn(content: string): { before: string; names: string[] } | null {
  const start = FEAT_START.exec(content)
  if (start) return { before: '', names: splitNames(content.slice(start[0].length)) }
  const inside = FEAT_INSIDE.exec(content)
  if (!inside) return null
  return {
    before: content.slice(0, inside.index).trim(),
    names: splitNames(content.slice(inside.index + inside[0].length)),
  }
}

/** Whether a group's content reads as a qualifier rather than part of the title. */
function isQualifierLike(content: string): boolean {
  return (
    FEAT_START.test(content) ||
    content.search(NOISE_PHRASES) >= 0 ||
    content.search(GROUP_NOISE) >= 0 ||
    hasVersionTag(content)
  )
}

/** Whether a dash suffix is a version ("Live", "2013 Remaster", "Tiësto Remix", "Lyrics"). */
function isVersionSuffix(segment: string): boolean {
  if (VERSION_SUFFIX.test(normalizeText(segment))) return true
  return /[\p{L}\p{N}]/u.test(segment) && isOnlyNoise(segment, SEGMENT_NOISE)
}

/** Blanks out `text[start, end)` with spaces, keeping every other index in place. */
function blank(text: string, start: number, end: number): string {
  return `${text.slice(0, start)}${' '.repeat(end - start)}${text.slice(end)}`
}

/**
 * Splits a title into its core, its qualifiers and its featured artists:
 *
 * - bracketed groups — `(...)`, `[...]`, `{...}`, `【...】` and full-width forms, nested or not
 *   — become qualifiers, or featured artists when they start with "feat.", "ft", "featuring"
 *   or "with". A group at the very start stays in the core unless it looks like a qualifier,
 *   so "(I Can't Get No) Satisfaction" keeps its title
 * - " - " suffixes become qualifiers when they read as a version: "Live", "Live at Wembley",
 *   "2013 Remaster", "Radio Edit", "Tiësto Remix", 'From "Frozen"', "Lyrics". Anything else
 *   stays, so "Artist - Title" is kept whole
 * - an unbracketed "feat. X" / "ft. X" / "featuring X" becomes featured artists up to the next
 *   " - ", so "Artist ft. X - Title" keeps "Artist - Title" as its core
 * - featured names are split on commas, `&`, "and" and "x"
 *
 * Strip a known "Artist - " prefix before calling it: a one-word title that is also a version
 * word ("Depeche Mode - Stripped") otherwise reads as a suffix. When nothing would be left of
 * the core, the whole title is the core.
 */
export function splitTitle(title: string): TitleParts {
  const text = tidy(title)
  const qualifiers: Array<{ at: number; text: string }> = []
  const featured: Array<{ at: number; names: string[] }> = []
  let rest = text

  for (const group of findGroups(text)) {
    const content = tidy(group.content)
    const leading = text.slice(0, group.start).trim() === ''
    if (leading && !isQualifierLike(content)) continue
    rest = blank(rest, group.start, group.end)
    const feat = featuredIn(content)
    if (feat) featured.push({ at: group.start, names: feat.names })
    const qualifier = feat ? feat.before : content
    if (qualifier !== '') qualifiers.push({ at: group.start, text: qualifier })
  }

  const tilde = TILDE_GROUP.exec(rest)
  if (tilde?.[1] && rest.slice(0, tilde.index).trim() !== '') {
    qualifiers.push({ at: tilde.index, text: tidy(tilde[1]) })
    rest = blank(rest, tilde.index, rest.length)
  }

  for (let last = [...rest.matchAll(DASH_SEPARATOR)].at(-1); last; ) {
    const at = last.index + last[0].length
    const segment = rest.slice(at).trim()
    const lead = FEAT_LEAD.exec(segment)
    if (lead) featured.push({ at, names: splitNames(segment.slice(lead[0].length)) })
    else if (segment !== '' && isVersionSuffix(segment)) qualifiers.push({ at, text: segment })
    else if (segment !== '') break
    rest = rest.slice(0, last.index)
    last = [...rest.matchAll(DASH_SEPARATOR)].at(-1)
  }

  const inline = FEAT_INLINE.exec(rest)
  if (inline) {
    const namesAt = inline.index + inline[0].length
    const end = NAMES_END.exec(rest.slice(namesAt))
    const namesEnd = end ? namesAt + end.index : rest.length
    featured.push({ at: inline.index, names: splitNames(rest.slice(namesAt, namesEnd)) })
    rest = blank(rest, inline.index, namesEnd)
  }

  const core = tidy(rest).replace(REPEATED_DASH, '$1').replace(EDGE_PUNCTUATION, '')
  if (core === '') return { core: text, qualifiers: [], featured: [] }
  const names = featured.sort((a, b) => a.at - b.at).flatMap((entry) => entry.names)
  return {
    core,
    qualifiers: qualifiers.sort((a, b) => a.at - b.at).map((entry) => entry.text),
    featured: [...new Set(names)],
  }
}
