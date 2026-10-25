# Lyrics (`@fxm/core`)

Reads and writes LRC, and finds what is sung at a moment of playback. Pure functions with no I/O, exported from `@fxm/core`. The types (`Lyrics`, `LyricLine`, `LyricWord`, `LyricsMetadata`) live with `LyricsProvider` in [`providers.ts`](../providers.ts).

| Function | What it does |
|---|---|
| `parseLrc(text, source?, options?)` | LRC or plain text → `Lyrics`. Synced when the text has timed lines, plain when it has none or its untimed text lines outnumber them. `{ plain: true }` reads any text as plain. Never throws |
| `serializeLrc(lyrics)` | `Lyrics` → LRC text. `parseLrc` reads it back to equal lyrics |
| `lineAt(lyrics, timeMs)` | Index of the line sung at `timeMs` (binary search), or -1 |
| `wordAt(line, timeMs)` | Index of the word sung at `timeMs` in an enhanced line, or -1 |

## What `parseLrc` understands

| Input | Result |
|---|---|
| `[mm:ss.xx]`, `[mm:ss]`, `[mm:ss.x]`, `[mm:ss.xxx]`, `[mm:ss:xx]`, `[123:45.67]`, `[ 01:02.00 ]` | Line start in milliseconds. A third part is always the fraction, never hours. A negative time is zero |
| `[00:12.00][01:30.00]Chorus` | One line per timestamp, all sorted by time (ties keep the file order) |
| `[offset:+500]` | Every time becomes `time − offset`, at least zero: a positive offset shows the lyrics sooner. It may stand anywhere; the last one wins. The result's times already include it |
| `[ti:]`, `[ar:]`, `[al:]`, `[length:mm:ss.xx]` | `metadata.title`, `artist`, `album`, `lengthMs` |
| `[au:]`, `[by:]`, `[re:]`, `[tool:]`, `[ve:]`, `[la:]`, `[lang:]`, `[id:]`, `[#:]` | Skipped. Any other bracketed text, such as `[Chorus]` or `[Verse 1: Artist]`, stays lyrics |
| `<mm:ss.xx>word` (enhanced LRC) | `line.words`: each word's start, its text with the following space, and its `endMs` when a word timestamp with no text follows it. Text before the first word timestamp starts with the line. On a line with several timestamps, the word times belong to the one nearest the first word, and the other copies are shifted with them |
| CRLF, CR or LF, a byte order mark, blank lines, spaces around text | Handled |

Synced lyrics drop their few untimed text lines (credits, stray text) and keep a timed line without text as an empty line, which marks a pause. When untimed text lines outnumber the timed lines, the text is plain lyrics with stray timestamps, and it is read as plain (blank lines and `[key:value]` lines don't count as text). Plain lyrics keep every line once, in the file's order and without timestamps, fold runs of blank lines into one empty line (a stanza break) and drop blank lines at either end.

## Rules worth knowing

- **Times are final.** `lines` come sorted with the offset applied, so the player calls `lineAt(lyrics, position)` on every frame without preparing anything.
- **Words spell the line.** `line.words.map((word) => word.text).join('')` is always `line.text`, so a karaoke view can render the words in place of the text. Scripts without spaces, such as Japanese, get no spaces.
- **Round trips.** `parseLrc(serializeLrc(lyrics))` equals `lyrics` for anything `parseLrc` returned. Times are written as `mm:ss.xx`, or `mm:ss.xxx` when hundredths are not exact. No `[offset:]` is written, because the times already include it. The one exception is a plain line that reads as an LRC tag or timestamp, such as `[ti:x]`. LRC cannot write that as text, and only a timed line whose timestamps were dropped for plain lyrics can produce one.
- **Hostile input stays cheap.** No pattern backtracks through long runs of spaces, and a line may carry any number of timestamps, so lyrics from a public database can't stall the app or overflow the stack. A line's word timing is copied to its other timestamps for at most 10,000 word timings in all; past that, only the copy the word times belong to keeps its words.
