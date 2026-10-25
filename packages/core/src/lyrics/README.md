# Lyrics (`@fxm/core`)

Reads and writes LRC, and finds what is sung at a moment of playback. Pure functions with no I/O, exported from `@fxm/core`. The types (`Lyrics`, `LyricLine`, `LyricWord`, `LyricsMetadata`) live with `LyricsProvider` in [`providers.ts`](../providers.ts).

| Function | What it does |
|---|---|
| `parseLrc(text, source?)` | LRC or plain text → `Lyrics`. Synced when at least one line has a timestamp, plain otherwise. Never throws |
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

Synced lyrics drop untimed text lines and keep a timed line without text as an empty line, which marks a pause. Plain lyrics keep every line, fold runs of blank lines into one empty line (a stanza break) and drop blank lines at either end.

## Rules worth knowing

- **Times are final.** `lines` come sorted with the offset applied, so the player calls `lineAt(lyrics, position)` on every frame without preparing anything.
- **Words spell the line.** `line.words.map((word) => word.text).join('')` is always `line.text`, so a karaoke view can render the words in place of the text. Scripts without spaces, such as Japanese, get no spaces.
- **Round trips.** `parseLrc(serializeLrc(lyrics))` equals `lyrics` for anything `parseLrc` returned. Times are written as `mm:ss.xx`, or `mm:ss.xxx` when hundredths are not exact. No `[offset:]` is written, because the times already include it.
