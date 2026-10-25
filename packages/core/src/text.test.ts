import { describe, expect, it } from 'vitest'
import {
  extractVersionTags,
  normalizeText,
  splitTitle,
  stripPresentationNoise,
  type TitleParts,
  type VersionTags,
} from './text'

const SOFT_HYPHEN = String.fromCodePoint(0x00ad)
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b)
const BOM = String.fromCodePoint(0xfeff)
const COMBINING_VOICED_MARK = String.fromCodePoint(0x3099)

describe('normalizeText', () => {
  it.each([
    // Latin diacritics, strokes and ligatures
    ['Beyoncé', 'beyonce'],
    ['Motörhead', 'motorhead'],
    ['Sigur Rós', 'sigur ros'],
    ['Mø', 'mo'],
    ['Łódź', 'lodz'],
    ['Straße', 'strasse'],
    ['Ærøskøbing', 'aeroskobing'],
    ['Œuvre', 'oeuvre'],
    ['Þór Ðoð', 'thor dod'],
    ['Việt Nam', 'viet nam'],
    ['İstanbul', 'istanbul'],
    ['Işık', 'isik'],
    ['ﬁre', 'fire'],
    // Compatibility forms
    ['Ｈｅｌｌｏ　Ｗｏｒｌｄ', 'hello world'],
    ['①②', '12'],
    // Quotes, apostrophes and dashes
    ['Don’t Stop', "don't stop"],
    ['Don´t Stop', "don't stop"],
    ['Don`t Stop', "don't stop"],
    ['“Quoted”', '"quoted"'],
    ['«Chanson»', '"chanson"'],
    ['A – B — C', 'a - b - c'],
    ['x−y', 'x-y'],
    ['夢〜', '夢~'],
    // Whitespace and invisible characters
    ['  lots \t of\n space  ', 'lots of space'],
    [`a${SOFT_HYPHEN}b${ZERO_WIDTH_SPACE}c${BOM}`, 'abc'],
    ['', ''],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeText(input)).toBe(expected)
  })

  it.each([
    ['Devanagari', 'आज फिर तुमपे प्यार आया है'],
    ['Japanese', '夜に駆ける'],
    ['Korean', '사랑했나봐'],
    ['Chinese', '告白气球'],
    ['Arabic', 'حبيبي'],
    ['Thai', 'คิดถึง'],
  ])('leaves %s intact', (_script, text) => {
    expect(normalizeText(text)).toBe(text)
  })

  it.each([
    ['Cyrillic й and ё', 'Ёлка и йогурт', 'ёлка и йогурт'],
    ['Greek accents', 'Ἀθῆναι', 'ἀθῆναι'],
    ['a decomposed kana', `カ${COMBINING_VOICED_MARK}`, 'ガ'],
  ])('keeps the marks of non-Latin scripts: %s', (_label, input, expected) => {
    expect(normalizeText(input)).toBe(expected)
  })

  it('is idempotent', () => {
    for (const text of ['Beyoncé – “Halo”', 'क़िस्मत', 'İstanbul ﬁ', 'Ｍø〜', 'カ゛']) {
      const once = normalizeText(text)
      expect(normalizeText(once)).toBe(once)
    }
  })
})

describe('splitTitle', () => {
  const parts = (core: string, qualifiers: string[] = [], featured: string[] = []): TitleParts => ({
    core,
    qualifiers,
    featured,
  })

  it.each([
    // Featured artists
    ['Song (feat. Artist B)', parts('Song', [], ['Artist B'])],
    ['Song (feat. A, B & C)', parts('Song', [], ['A', 'B', 'C'])],
    ['Song (Featuring A and B)', parts('Song', [], ['A', 'B'])],
    ['Song (ft Drake)', parts('Song', [], ['Drake'])],
    ['Song (with Camila Cabello)', parts('Song', [], ['Camila Cabello'])],
    ['Song (feat. Lil Nas X)', parts('Song', [], ['Lil Nas X'])],
    ['Song (A x B Remix feat. C)', parts('Song', ['A x B Remix'], ['C'])],
    ['Song (feat. A) [feat. A]', parts('Song', [], ['A'])],
    ['Song ft. A', parts('Song', [], ['A'])],
    ['Song feat Artist', parts('Song', [], ['Artist'])],
    ['Song featuring A, B and C', parts('Song', [], ['A', 'B', 'C'])],
    ['Song ft Artist', parts('Song ft Artist')],
    ['Soft Cell - Tainted Love', parts('Soft Cell - Tainted Love')],
    [
      'Calvin Harris ft. Rihanna - This Is What You Came For',
      parts('Calvin Harris - This Is What You Came For', [], ['Rihanna']),
    ],
    [
      'Lil Nas X ft. Billy Ray Cyrus - Old Town Road (Remix)',
      parts('Lil Nas X - Old Town Road', ['Remix'], ['Billy Ray Cyrus']),
    ],
    ['Song - feat. X', parts('Song', [], ['X'])],
    ['Song - With You', parts('Song - With You')],
    // Brackets
    ['Song (feat. A & B) [Remix]', parts('Song', ['Remix'], ['A', 'B'])],
    ['Song (Tiësto Remix) [feat. A, B & C]', parts('Song', ['Tiësto Remix'], ['A', 'B', 'C'])],
    ['Song {Live}', parts('Song', ['Live'])],
    ['Song （Live）', parts('Song', ['Live'])],
    ['Song 【MV】', parts('Song', ['MV'])],
    ['[MV] Song', parts('Song', ['MV'])],
    ['Song (From "Movie (2019)")', parts('Song', ['From "Movie (2019)"'])],
    ['Song (Part 2)', parts('Song', ['Part 2'])],
    ['Song [] ()', parts('Song')],
    ['Song (unclosed', parts('Song (unclosed')],
    ['Song (a ] b)', parts('Song', ['a ] b'])],
    ["(I Can't Get No) Satisfaction", parts("(I Can't Get No) Satisfaction")],
    ["(Don't Fear) The Reaper (Live)", parts("(Don't Fear) The Reaper", ['Live'])],
    ['(Official Video) Song', parts('Song', ['Official Video'])],
    ['(Live)', parts('(Live)')],
    ['Live Forever (Live at Knebworth)', parts('Live Forever', ['Live at Knebworth'])],
    ['Song (Live) - Artist', parts('Song - Artist', ['Live'])],
    // Dash suffixes
    ['Song - 2013 Remaster', parts('Song', ['2013 Remaster'])],
    ['Song - Remastered 2011', parts('Song', ['Remastered 2011'])],
    ['Song - Live', parts('Song', ['Live'])],
    ['Song – Live', parts('Song', ['Live'])],
    ['Song — Live in London 2019', parts('Song', ['Live in London 2019'])],
    ['Song - Recorded Live at Abbey Road', parts('Song', ['Recorded Live at Abbey Road'])],
    ['Song - Live at Wembley - 2011 Remaster', parts('Song', ['Live at Wembley', '2011 Remaster'])],
    ['Song - Single Version', parts('Song', ['Single Version'])],
    ['Song - Radio Edit', parts('Song', ['Radio Edit'])],
    ['Song - Original Mix', parts('Song', ['Original Mix'])],
    ['Song - Bonus Track', parts('Song', ['Bonus Track'])],
    ['Song - Acoustic', parts('Song', ['Acoustic'])],
    ["Song - Taylor's Version", parts('Song', ["Taylor's Version"])],
    ['Song - Slowed + Reverb', parts('Song', ['Slowed + Reverb'])],
    [
      "(I Can't Get No) Satisfaction - Mono Version",
      parts("(I Can't Get No) Satisfaction", ['Mono Version']),
    ],
    [
      'Let It Go - From "Frozen"/Soundtrack Version',
      parts('Let It Go', ['From "Frozen"/Soundtrack Version']),
    ],
    [
      'Song - From The Motion Picture "Barbie"',
      parts('Song', ['From The Motion Picture "Barbie"']),
    ],
    ['Song - prod. by Metro Boomin', parts('Song', ['prod. by Metro Boomin'])],
    ['Song - Official Video', parts('Song', ['Official Video'])],
    ['Song - Lyrics', parts('Song', ['Lyrics'])],
    ['Song (feat. A) - Live', parts('Song', ['Live'], ['A'])],
    ['Song - (Live)', parts('Song', ['Live'])],
    ['Song -  - Live', parts('Song', ['Live'])],
    ['Song - feat. X - Artist', parts('Song - Artist', [], ['X'])],
    ['Song -', parts('Song')],
    // Dashes that stay
    ['Artist - Song', parts('Artist - Song')],
    ['Artist - Song (Official Video)', parts('Artist - Song', ['Official Video'])],
    ['Oasis - Live Forever', parts('Oasis - Live Forever')],
    ['Taylor Swift - Long Live', parts('Taylor Swift - Long Live')],
    ['Taylor Swift - Clean', parts('Taylor Swift - Clean')],
    ['The Beatles - From Me To You', parts('The Beatles - From Me To You')],
    ['Song - Pt. 2', parts('Song - Pt. 2')],
    ['Song - Interlude', parts('Song - Interlude')],
    ['Jay-Z - Song', parts('Jay-Z - Song')],
    // Whitespace
    ['   Song   (Live)  ', parts('Song', ['Live'])],
    ['', parts('')],
  ])('splits %j', (title, expected) => {
    expect(splitTitle(title)).toEqual(expected)
  })

  it.each([
    ['夜に駆ける (Live)', parts('夜に駆ける', ['Live'])],
    ['アイドル (TV Size)', parts('アイドル', ['TV Size'])],
    ['【MV】夜に駆ける', parts('夜に駆ける', ['MV'])],
    ['(Live) 夜に駆ける', parts('夜に駆ける', ['Live'])],
    ['「アイドル」', parts('「アイドル」')],
    ['君の知らない物語 ~Short Ver.~', parts('君の知らない物語', ['Short Ver.'])],
    ['紅蓮華 〜TV Size〜', parts('紅蓮華', ['TV Size'])],
    ['사랑했나봐 (Inst.)', parts('사랑했나봐', ['Inst.'])],
    ['केसरिया - Lofi Mix', parts('केसरिया', ['Lofi Mix'])],
    ['Kesariya (From "Brahmastra")', parts('Kesariya', ['From "Brahmastra"'])],
    ['Кино - Группа крови', parts('Кино - Группа крови')],
    ['حبيبي (Remix)', parts('حبيبي', ['Remix'])],
    ['告白气球 (feat. 周杰伦、方文山)', parts('告白气球', [], ['周杰伦', '方文山'])],
  ])('splits the non-Latin title %j', (title, expected) => {
    expect(splitTitle(title)).toEqual(expected)
  })

  it('reads a version word as a suffix unless the artist prefix is removed first', () => {
    expect(splitTitle('Depeche Mode - Stripped')).toEqual(parts('Depeche Mode', ['Stripped']))
    expect(splitTitle('Stripped')).toEqual(parts('Stripped'))
  })
})

describe('stripPresentationNoise', () => {
  it.each([
    ['Song (Official Music Video)', 'Song'],
    ['Song (Official Video)', 'Song'],
    ['Song (Official Audio)', 'Song'],
    ['Song (Official Lyric Video)', 'Song'],
    ['Song (Official HD Video)', 'Song'],
    ['Song [Official 4K Video]', 'Song'],
    ['Song (Official Visualizer)', 'Song'],
    ['Song (Visualiser)', 'Song'],
    ['Song (Lyrics)', 'Song'],
    ['Song [Lyric Video]', 'Song'],
    ['Song (Lyrics & Translation)', 'Song'],
    ['Song | Lyrics', 'Song'],
    ['Song - Lyrics', 'Song'],
    ['Song Lyrics', 'Song'],
    ['Artist - Song (Official Music Video) // Lyrics', 'Artist - Song'],
    ['Song [M/V]', 'Song'],
    ['【MV】Song', 'Song'],
    ['MV | Song', 'Song'],
    ["BTS (방탄소년단) 'Dynamite' Official MV", "BTS (방탄소년단) 'Dynamite'"],
    ['YOASOBI「アイドル」 Official Music Video', 'YOASOBI「アイドル」'],
    ['Song (Audio)', 'Song'],
    ['Song [HD]', 'Song'],
    ['Song (HQ)', 'Song'],
    ['Song [4K]', 'Song'],
    ['Song HD', 'Song'],
    ['Song (Letra)', 'Song'],
    ['Song (Letra/Lyrics)', 'Song'],
    ['Song (Tradução)', 'Song'],
    ['Song (Traducao)', 'Song'],
    ['Song (Traducción)', 'Song'],
    ['Song [Lirik]', 'Song'],
    ['Song (Video Oficial)', 'Song'],
    ['Song (Videoclip Oficial)', 'Song'],
    ['Song (Áudio Oficial)', 'Song'],
    ['Song (Explicit)', 'Song'],
    ['Song [Clean]', 'Song'],
    ['Song (Uncensored)', 'Song'],
    ['Song (Official Video (HD))', 'Song'],
    ['Song (Official Video) ft. X', 'Song ft. X'],
    ['Artist - Song (Official Music Video) | 4K', 'Artist - Song'],
    ['Full Video: Kesariya | Brahmastra', 'Kesariya | Brahmastra'],
    ['Lyrical: Kesariya', 'Kesariya'],
    ['Artist - (Official Video) - Song', 'Artist - Song'],
    ['Lyrics | Artist - Song | HD', 'Artist - Song'],
    ['Song | | Lyrics', 'Song'],
  ])('cleans %j to %j', (title, expected) => {
    expect(stripPresentationNoise(title)).toBe(expected)
  })

  it.each([
    ['Artist - Song [Official Video] (Remastered 2009)', 'Artist - Song (Remastered 2009)'],
    ['Song (Live) [Official Video]', 'Song (Live)'],
    ['Song (Lyrics) (Sped Up)', 'Song (Sped Up)'],
    ['Song (Official Video) [HD] (Remix)', 'Song (Remix)'],
    ['Song [4K Remaster]', 'Song [4K Remaster]'],
    ['Song (Official Live Video)', 'Song (Official Live Video)'],
  ])('keeps version information in %j', (title, expected) => {
    expect(stripPresentationNoise(title)).toBe(expected)
  })

  it.each([
    'Taylor Swift - Clean',
    'Clean',
    'Audio',
    'Lyrics',
    'Explicit',
    'Music Video',
    'Video Killed the Radio Star',
    'Official',
    'Kesariya | Brahmastra | Arijit Singh',
    'Kesariya|Brahmastra',
  ])('leaves the title %j alone', (title) => {
    expect(stripPresentationNoise(title)).toBe(title)
  })

  it('tidies whitespace and handles empty input', () => {
    expect(stripPresentationNoise('  Song   (Lyrics)  ')).toBe('Song')
    expect(stripPresentationNoise('')).toBe('')
    expect(stripPresentationNoise('   ')).toBe('')
  })
})

describe('extractVersionTags', () => {
  const tags = (
    strong: string[] = [],
    medium: string[] = [],
    soft: string[] = [],
  ): VersionTags => ({
    strong,
    medium,
    soft,
  })

  it.each([
    // Strong: live performances
    ['Live', tags(['live'])],
    ['Livestream', tags(['live'])],
    ['En Vivo', tags(['live'])],
    ['Ao Vivo', tags(['live'])],
    ['En Directo', tags(['live'])],
    ['Song @ The Garage', tags(['live'])],
    ['MTV Unplugged', tags(['unplugged'])],
    ['In Concert', tags(['concert'])],
    ['World Tour 2019', tags(['tour'])],
    ['Glastonbury Festival', tags(['festival'])],
    ['Coachella', tags(['festival'])],
    ['Rock in Rio', tags(['festival'])],
    ['Spotify Sessions', tags(['session'])],
    ['Artist Performs Song', tags(['performance'])],
    ['Live Performance', tags(['live', 'performance'])],
    ['Tiny Desk Concert', tags(['tiny desk'])],
    // Strong: remixes and edits by others
    ['Remix', tags(['remix'])],
    ['Remixed', tags(['remix'])],
    ['RMX', tags(['remix'])],
    ['Rework', tags(['rework'])],
    ['Refix', tags(['rework'])],
    ['Bootleg', tags(['bootleg'])],
    ['Club Mix', tags(['club mix'])],
    ['Dub Mix', tags(['dub mix'])],
    ['VIP Mix', tags(['vip mix'])],
    ['VIP', tags(['vip mix'])],
    ['Extended Mix', tags(['extended'])],
    ['Extended Version', tags(['extended'])],
    ['12" Version', tags(['12" version'])],
    ['12 Inch Mix', tags(['12" version'])],
    ['Mashup', tags(['mashup'])],
    ['Medley', tags(['medley'])],
    // Strong: covers and karaoke
    ['Cover', tags(['cover'])],
    ['Covered by X', tags(['cover'])],
    ['Acoustic Cover', tags(['acoustic', 'cover'])],
    ['Karaoke Version', tags(['karaoke'])],
    ['Tribute to Queen', tags(['tribute'])],
    ['Originally Performed by Adele', tags(['originally performed by'])],
    ['In the Style of Adele', tags(['in the style of'])],
    ['As Made Famous by Adele', tags(['made famous by'])],
    ['Backing Track', tags(['backing track'])],
    ['Instrumental', tags(['instrumental'])],
    ['Inst.', tags(['instrumental'])],
    ['Minus One', tags(['minus one'])],
    ['Off Vocal', tags(['off vocal'])],
    ['A Cappella', tags(['acapella'])],
    // Strong: arrangements
    ['Acoustic', tags(['acoustic'])],
    ['Acústico', tags(['acoustic'])],
    ['Versión Acústica', tags(['acoustic'])],
    ['Stripped Back', tags(['stripped'])],
    ['Piano Version', tags(['piano version'])],
    ['Piano Ver.', tags(['piano version'])],
    ['Orchestral Version', tags(['orchestral'])],
    ['Symphonic', tags(['symphonic'])],
    // Strong: speed and effects
    ['Sped Up', tags(['sped up'])],
    ['Speed Up', tags(['sped up'])],
    ['sped-up', tags(['sped up'])],
    ['Slowed Down', tags(['slowed'])],
    ['Slowed + Reverb', tags(['slowed', 'reverb'])],
    ['Nightcore', tags(['nightcore'])],
    ['8D Audio', tags(['8d'])],
    ['Bass Boosted', tags(['bass boosted'])],
    ['Daycore', tags(['daycore'])],
    ['Lofi', tags(['lo-fi'])],
    ['Lo-Fi', tags(['lo-fi'])],
    ['Lo Fi', tags(['lo-fi'])],
    ['Chopped and Screwed', tags(['chopped', 'screwed'])],
    // Strong: other takes and recordings
    ['Demo', tags(['demo'])],
    ['Home Demo', tags(['demo'])],
    ['Rehearsal', tags(['rehearsal'])],
    ['Outtake', tags(['outtake'])],
    ['Alternate Take', tags(['alternate take'])],
    ['Alt. Take', tags(['alternate take'])],
    ['Alternative Version', tags(['alternate take'])],
    ['Take 2', tags(['take 2'])],
    ['Take 12', tags(['take 12'])],
    ['Early Version', tags(['early version'])],
    ["Taylor's Version", tags(["taylor's version"])],
    ['Taylor’s Version', tags(["taylor's version"])],
    ['Taylors Version', tags(["taylor's version"])],
    ['Re-Recorded', tags(['re-recorded'])],
    ['Rerecorded', tags(['re-recorded'])],
    ['Reprise', tags(['reprise'])],
    ['Spanish Version', tags(['spanish version'])],
    ['English Ver.', tags(['english version'])],
    ['Eng Ver.', tags(['english version'])],
    ['Versión en Español', tags(['spanish version'])],
    ['Version Française', tags(['french version'])],
    // Medium
    ['Radio Edit', tags([], ['radio edit'])],
    ['Radio Version', tags([], ['radio edit'])],
    ['Single Version', tags([], ['single edit'])],
    ['Short Version', tags([], ['short edit'])],
    ['Shortened', tags([], ['short edit'])],
    ['Clean Version', tags([], ['clean edit'])],
    ['Video Edit', tags([], ['video edit'])],
    ['TV Ver.', tags([], ['tv edit'])],
    ['TV Size', tags([], ['tv size'])],
    ['Anime Size', tags([], ['tv size'])],
    ['Edit', tags([], ['edit'])],
    ['Steve Angello Edit', tags([], ['edit'])],
    // Soft
    ['Remastered', tags([], [], ['remaster'])],
    ['2011 Remaster', tags([], [], ['remaster'])],
    ['Remastered 2009', tags([], [], ['remaster'])],
    ['Digitally Remastered', tags([], [], ['remaster'])],
    ['25th Anniversary Edition', tags([], [], ['anniversary'])],
    ['Deluxe Edition', tags([], [], ['deluxe'])],
    ['Mono', tags([], [], ['mono'])],
    ['Stereo Mix', tags([], [], ['stereo'])],
    ['Dolby Atmos', tags([], [], ['dolby atmos'])],
    ['Atmos', tags([], [], ['dolby atmos'])],
    ['Spatial Audio', tags([], [], ['spatial'])],
  ])('finds the tags of %j', (text, expected) => {
    expect(extractVersionTags(text)).toEqual(expected)
  })

  it.each([
    'Alive',
    'Olive',
    'Delivery',
    'Lives',
    'Coverage',
    'Discover',
    'Undercover',
    'Demonstration',
    'Demolition',
    'Editorial',
    'Credits',
    'Monotone',
    'Stereotype',
    'Atmosphere',
    'Tourist',
    'Possession',
    'Attribute',
    'Concerto',
    'Instant',
    'Reverberation',
    'Remixologist',
    'Extended Play',
    'user@example.com',
    'Take Five',
    '18D',
    'Halo Fi',
    'Never Gonna Give You Up',
    // Katakana and Hangul tag words inside longer words of their script
    'ドライブ',
    '드라이브',
    'ライブラリ',
    'ﾄﾞﾗｲﾌﾞ',
    'ディスカバー',
    '디스커버리',
    'インストール',
    '歌ってみたい',
  ])('finds no tag in %j', (text) => {
    expect(extractVersionTags(text)).toEqual(tags())
  })

  it.each([
    ['夜に駆ける (Live)', tags(['live'])],
    ['夜に駆ける ライブ映像', tags(['live'])],
    ['레디 포 러브 라이브', tags(['live'])],
    ['Ｌｉｖｅ', tags(['live'])],
    ['【歌ってみた】夜に駆ける', tags(['cover'])],
    ['残酷な天使のテーゼ カバー', tags(['cover'])],
    ['Кукушка (кавер)', tags(['cover'])],
    ['사랑했나봐 (Inst.)', tags(['instrumental'])],
    ['告白气球 (伴奏)', tags(['instrumental'])],
    ['紅蓮華 TVサイズ', tags([], ['tv size'])],
    ['केसरिया (Lofi Mix)', tags(['lo-fi'])],
    ['केसरिया (Unplugged)', tags(['unplugged'])],
    ['Группа крови (Live)', tags(['live'])],
    ['حبيبي (Remix)', tags(['remix'])],
    ["Σ' αγαπώ (Live)", tags(['live'])],
    ['アイドル', tags()],
    ['आज फिर तुमपे प्यार आया है', tags()],
    // Katakana and Hangul compounds with Han, punctuation or another known word
    ['インストゥルメンタル', tags(['instrumental'])],
    ['カバーソング', tags(['cover'])],
    ['カバー曲', tags(['cover'])],
    ['커버곡', tags(['cover'])],
    ['アコースティックライブ', tags(['acoustic', 'live'])],
    ['スタジオライブ', tags(['live'])],
    ['ライブバージョン', tags(['live'])],
    ['ライブ・バージョン', tags(['live'])],
    ['라이브영상', tags(['live'])],
    ['리믹스 버전', tags(['remix'])],
    ['オフボーカル', tags(['off vocal'])],
    ['TVサイズ版', tags([], ['tv size'])],
    ['アニメサイズ', tags([], ['tv size'])],
  ])('handles the non-Latin title %j', (text, expected) => {
    expect(extractVersionTags(text)).toEqual(expected)
  })

  it('lists each tag once, in order of appearance, across classes', () => {
    expect(
      extractVersionTags('Remix (Live at Wembley) [2011 Remaster] - Radio Edit - live remix'),
    ).toEqual(tags(['remix', 'live'], ['radio edit'], ['remaster']))
  })

  it('lets a longer phrase win over the words inside it', () => {
    expect(extractVersionTags('Radio Edit')).toEqual(tags([], ['radio edit']))
    expect(extractVersionTags('Extended Edit')).toEqual(tags(['extended']))
    expect(extractVersionTags('Tiny Desk Concert')).toEqual(tags(['tiny desk']))
  })
})
