import { describe, expect, it } from 'vitest'
import {
  type Finding,
  looksLikeCode,
  looksLikeProse,
  scanAndroidStrings,
  scanAstro,
  scanDocument,
  scanJvm,
  scanRust,
  scanScript,
  stringLiterals,
  wordCount,
} from './strings.ts'

const texts = (findings: readonly Finding[]) =>
  findings.map(({ category, text }) => `${category}: ${text}`)

describe('looksLikeCode and looksLikeProse', () => {
  it.each([
    'grid min-h-dvh place-items-center px-gutter',
    'text-text-muted hover:bg-text/8 hover:text-text',
    'https://fxmusic.pages.dev/app/',
    '/app/search',
    'audio/webm; codecs="opus"',
    '++id, trackId, playedAt',
    "worker-src 'self'",
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
    'M4.5 4h15A1.5 1.5 0 0 1 21 5.5v13Z',
    '<defs><linearGradient id="g" x1="0">',
    'fxm.settings.v1',
    'music-video',
    'YouTube',
  ])('reads %j as code', (text) => {
    expect(looksLikeCode(text)).toBe(true)
    expect(looksLikeProse(text)).toBe(false)
  })

  it.each([
    'Songs, artists, albums',
    'your browser',
    "Can't play: open FXM to see why",
    'Sleep timer, speed, volume and equalizer.',
  ])('reads %j as prose', (text) => {
    expect(looksLikeProse(text)).toBe(true)
  })

  it('reads one capitalized word as a word, not code', () => {
    expect(looksLikeCode('Settings')).toBe(false)
    expect(looksLikeProse('Settings')).toBe(false)
  })
})

describe('scanScript', () => {
  it('counts a run of JSX text as one message, inline elements and values included', () => {
    const source = `
      export const Notice = ({ name, n }) => (
        <section className="flex gap-2">
          <h2>Library</h2>
          <p>
            Read the <a href="/notes">release notes</a>, {name}. Pick {n} more {n === 1 ? 'artist' : 'artists'}.
          </p>
          <span className="sr-only">{' '}</span>
          <p>{isOn ? 'Sync is on' : 'Sync is off'}</p>
        </section>
      )`
    expect(texts(scanScript(source, 'notice.tsx'))).toEqual([
      'text: Library',
      'text: Read the <>release notes</>, {}. Pick {} more {}.',
      'code: Sync is on',
      'code: Sync is off',
    ])
  })

  it('counts the attributes people read, and props that hold copy', () => {
    const source = `
      <div>
        <button aria-label="Clear search" type="button" className="size-touch" data-row="x" />
        <IconButton label={\`Play \${title}\`} aria-hidden="true" />
        <input placeholder="Songs, artists, albums" autoComplete="off" />
        <img alt="" src="/a.png" />
        <Count noun="song" plural="songs" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="A free music player" />
      </div>`
    expect(texts(scanScript(source, 'a.tsx'))).toEqual([
      'attribute: Clear search',
      'attribute: Play {}',
      'attribute: Songs, artists, albums',
      'attribute: song',
      'attribute: songs',
      'attribute: A free music player',
    ])
  })

  it('counts prose in code, and single words only where copy is expected', () => {
    const source = `
      import { x } from './some module'
      const LITE_CAVEAT = 'Lite relies on a way of reaching YouTube Music that YouTube doesn’t document.'
      const TRACK_KIND_LABELS = { song: 'Song', 'music-video': 'Official video' }
      const summary = { origin: 'local', name: 'Liked songs' }
      export function tierLabel(tier) { return tier === 'lite' ? 'Lite' : 'Full' }
      export function status(kind) { return kind === 'ok' ? 'Done' : 'Failed' }
      showStatus('Saved')
      showStatus(\`Removed \${title} from the queue.\`)
      console.warn('FXM could not load something')
      localStorage.setItem('fxm settings', 'x y')
      if (kind === 'two words') {}
      const options = { className: 'flex items-center', label: 'Theme', kind: 'Song' }
      el.textContent = 'Nothing'
      const page = { handle: tab('Home') }
      isFxmError(error, 'Network')
      type Mode = 'Music only'
    `
    expect(texts(scanScript(source, 'a.ts'))).toEqual([
      'code: Lite relies on a way of reaching YouTube Music that YouTube doesn’t document.',
      'code: Song',
      'code: Official video',
      'code: Liked songs',
      'code: Lite',
      'code: Full',
      'code: Saved',
      'code: Removed {} from the queue.',
      'code: Theme',
      'code: Nothing',
      'code: Home',
    ])
  })

  it('puts the messages of thrown errors in their own category', () => {
    const source = `
      throw new Error('The file is not valid JSON')
      reject(new FxmError('Network', 'GitHub can’t be reached right now'))
      throw new TypeError(\`Not a playlist: \${id}\`)
    `
    expect(texts(scanScript(source, 'a.ts'))).toEqual([
      'error: The file is not valid JSON',
      'error: GitHub can’t be reached right now',
      'error: Not a playlist: {}',
    ])
  })

  it('leaves names alone: brands and acronyms are not messages', () => {
    const source = `<p><span>FXM</span><b>YouTube Music</b>{'Spotify'}<i>FLAC</i></p>`
    expect(texts(scanScript(source, 'a.tsx'))).toEqual([
      'text: <>FXM</><>YouTube Music</>Spotify<>FLAC</>',
    ])
    expect(texts(scanScript('<h1>FXM Connect</h1>', 'b.tsx'))).toEqual([])
  })

  it('gives line numbers', () => {
    expect(scanScript("\n\nconst a = 'Two words here'", 'a.ts')).toEqual([
      { category: 'code', text: 'Two words here', line: 3 },
    ])
  })
})

describe('scanAstro', () => {
  it('reads the template, the frontmatter and client scripts, not styles', () => {
    const source = `---
const lead = 'Music from any source, in one player.'
---
<html lang="en">
  <head><title>Privacy</title><meta name="description" content="What FXM stores and sends"></head>
  <body>
    <p>Hi <a href="/x">there</a>, {lead} friend.</p>
    <img alt="FXM on a phone" src="/a.png">
    <script>document.title = 'Saved the playlist'</script>
    <style>p { color: red }</style>
  </body>
</html>`
    expect(texts(scanAstro(source))).toEqual([
      'code: Music from any source, in one player.',
      'text: Privacy',
      'attribute: What FXM stores and sends',
      'text: Hi <>there</>, {} friend.',
      'attribute: FXM on a phone',
      'code: Saved the playlist',
    ])
  })
})

describe('Rust, Kotlin and Java', () => {
  it('reads string literals around comments, char literals and raw strings', () => {
    const source = `// "not a string"
let a = "one"; let quote = '"'; let b = "two \\"quoted\\" words"; /* "nor this" */
let raw = r#"{"json": "raw"}"#; let lifetime: &'static str = "three";`
    expect(stringLiterals(source).map((literal) => literal.text)).toEqual([
      'one',
      'two "quoted" words',
      '{"json": "raw"}',
      'three',
    ])
  })

  it('counts the Rust shell’s copy and keeps errors and logs apart', () => {
    const source = `
const NOTHING_PLAYING: &str = "Nothing playing";
fn label(on: bool) -> &'static str { if on { "Pause" } else { "Play" } }
fn ua() -> String { format!("FXM/{} ( https://github.com/Pratyay-ops/FXM )", 1) }
fn fail() -> Result<(), String> { Err("The evaluator window is not open".to_string()) }
fn log() { log::warn!("Could not update the tray menu"); }
pub const TRAY_ID: &str = "fxm";
#[cfg(test)]
mod tests { const X: &str = "Not counted at all"; }`
    expect(texts(scanRust(source))).toEqual([
      'code: Nothing playing',
      'code: Pause',
      'code: Play',
      'error: The evaluator window is not open',
    ])
  })

  it('counts Kotlin and Java prose as copy only where UI calls show it', () => {
    const source = `
dialog.setTitle("Allow this server?")
call.reject("The player service is not available", UNAVAILABLE)
val text = "\${host} redirected to an invalid URL"`
    expect(texts(scanJvm(source))).toEqual([
      'code: Allow this server?',
      'error: The player service is not available',
      'error: {} redirected to an invalid URL',
    ])
  })
})

describe('scanAndroidStrings', () => {
  it('counts strings and plurals, not package names, the app’s name or untranslatable ones', () => {
    const source = `<resources>
    <string name="app_name">FXM</string>
    <string name="package_name">io.github.pratyayops.fxm</string>
    <string name="key" translatable="false">Some key</string>
    <plurals name="approve"><item quantity="one">Allow this?</item><item quantity="other">Allow these?</item></plurals>
    <string name="allow">Allow</string>
</resources>`
    expect(texts(scanAndroidStrings(source))).toEqual([
      'resource: Allow this? Allow these?',
      'resource: Allow',
    ])
  })
})

describe('scanDocument and wordCount', () => {
  it('counts paragraphs and list items', () => {
    const source = 'First paragraph,\nstill first.\n\n**Heading**\n\n- One item\n- Two items\n'
    expect(texts(scanDocument(source))).toEqual([
      'document: First paragraph, still first.',
      'document: Heading',
      'document: One item',
      'document: Two items',
    ])
  })

  it('counts words, not values or tags', () => {
    expect(wordCount('Read the <>release notes</>, {}.')).toBe(4)
  })
})
