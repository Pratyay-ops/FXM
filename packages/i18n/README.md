# @fxm/i18n

FXM's translations (stage 8.5, the i18n foundation): keyed messages in a subset of ICU MessageFormat, typed from their English text; locale negotiation; formatting through the platform's `Intl`; a React provider and hooks; two pseudo-locales; checks for translation files; and the string inventory that sizes the conversion of the apps. The design, and why it is built this way, is in [docs/I18N.md](../../docs/I18N.md).

No app imports it yet: converting the apps' text is phase 2 of the design.

| Entry | What it is | In an app's bundle |
|---|---|---|
| `@fxm/i18n` | `defineMessages`, `createI18n`, `negotiateLocale`, `requestedLocales`, `applyDocumentLocale`, `textDirection`, `fallbackChain`, the formatters (`formatNumber`, `formatDuration`, `formatDate`, `formatList`, … and `createFormatters`), `parseMessage` | Yes |
| `@fxm/i18n/react` | `I18nProvider`, `useT`, `useLocale`, `useFormat`, `useI18n` | Yes |
| `@fxm/i18n/pseudo` | `PSEUDO_LOCALES`: `en-XA` (accented, longer) and `ar-XB` (right to left) | Development builds and Diagnostics only |
| `@fxm/i18n/check` | `checkSource`, `checkCatalog`, `checkTranslation`, `sourceCatalog`, `completion` | Never: tests and CI |
| `@fxm/i18n/testing` | `findUntranslated`, `strictReporters` | Never: tests |

## Messages

A feature declares its English messages next to the code that shows them. Keys are camelCase words; the namespace is the first part of each message's id in translation files (`library.songCount`).

```ts
import { defineMessages } from '@fxm/i18n'

export const libraryMessages = defineMessages('library', {
  title: 'Library',
  songCount: '{count, plural, one {# song} other {# songs}}',
  removed: 'Removed “{title}” from <link>{playlist}</link>',
  addedOn: 'Added {at, date, medium}',
  tier: '{tier, select, free {Free only} lite {Lite} other {Full}}',
})
```

The syntax ([`src/parse.ts`](src/parse.ts) has the details):

| Write | For |
|---|---|
| `{name}` | A value: text as it is, numbers and dates formatted for the locale |
| `{n, number}`, `{n, number, integer}`, `{n, number, percent}` | Numbers |
| `{d, date}`, `{d, time, short}` (`short`, `medium`, `long`, `full`) | Dates and times |
| `{n, plural, =0 {…} one {# song} other {# songs}}` | Plurals by the locale's rules; `#` is the number |
| `{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}` | Ordinals |
| `{v, select, a {…} other {…}}` | A choice by value |
| `<link>…</link>` | Part of a sentence that a renderer wraps (a link, emphasis) |
| `''`, `'{literal}'` | An apostrophe before a brace or a tag quotes; "doesn't" needs nothing |

Anything else ICU has (`offset:`, skeletons, `choice`) is refused, so a message never means something different here than in a translator's tool.

The types come from the text: `t('songCount', { count: 3 })` compiles, `t('songCount')` and `t('songCount', { count: 'three' })` don't, and neither does a key that isn't there.

## Translating

```ts
import { createI18n, negotiateLocale, requestedLocales, applyDocumentLocale } from '@fxm/i18n'

const appI18n = createI18n({
  locales: ['de', 'pt', 'pt-BR'],
  // The app's lazy loader: one chunk per locale, made from its JSON files. English needs none.
  load: loadCatalog,
  onMissing: import.meta.env.DEV ? (m) => console.warn('No translation', m) : undefined,
  onError: (problem) => console.error('Message problem', problem),
})

const choice = negotiateLocale({
  available: appI18n.locales,
  defaultLocale: 'en',
  requested: requestedLocales(),
  preference: settings.language, // undefined: follow the browser
})
await appI18n.setLocale(choice.locale, choice.formatLocale)
applyDocumentLocale(choice) // <html lang dir>
```

- **Fallback.** A message a catalog lacks falls back along the locale's chain (`pt-BR`, then `pt`; never across scripts, so `zh-Hant` doesn't fall back to Simplified `zh`), then to English, and `onMissing` hears about it once. A translation that doesn't parse shows English and goes to `onError`; so does a value the code didn't pass, which shows as `{name}`.
- **Negotiation.** The Settings choice wins when there is a catalog for it; otherwise the first of the browser's languages that matches, by language and script with likely subtags (`zh-TW` gets `zh-Hant`), then by region; otherwise English. Numbers and dates use the user's own tag when it is the same language (`en-IN` keeps Indian digit grouping with the English messages).
- **Formatting.** `formatDuration(locale, 125)` is `2:05`; `formatDuration(locale, 3900, 'short')` is `1 hr 5 min`; also numbers, percentages, sizes (`4.2 MB`), dates, times, relative times (`yesterday`, `5 minutes ago`), lists (`a, b and c`), language names and sorting. `createFormatters(locale)` binds them all, at the cost of bundling them all.

In React:

```tsx
<I18nProvider i18n={appI18n}>…</I18nProvider>

const t = useT(libraryMessages)
t('songCount', { count })
t.rich('removed', { title, playlist, link: (children) => <Link to={to}>{children}</Link> })
const { locale, formatLocale, direction } = useLocale()
```

Components re-render when the locale changes or a catalog arrives; `useT`'s translator changes identity with them, so memoized children follow too. Outside React, `appI18n.translator(libraryMessages)` gives the same translator, which always speaks the current locale: call it when the text is shown, never at module load.

## Pseudo-locales

```ts
import { PSEUDO_LOCALES } from '@fxm/i18n/pseudo'

createI18n({ derived: PSEUDO_LOCALES, … }) // en-XA: ⟦Šééţţîîñĝš⟧, ar-XB: right to left
```

`en-XA` accents every letter, doubles the vowels (about a third longer) and brackets each message, so plain English on screen is text that skips the translations and a missing `⟧` is text cut off. `ar-XB` wraps each message in a right-to-left override in an `rtl` document, which shows where the layout uses physical CSS (`left`, `margin-right`) instead of logical properties. Both are made from the English messages as they are shown, so they need no catalog.

## Tests

Tests keep asserting English, which is the default locale and bundled. To prove a screen has no hard-coded text, render it in `en-XA` and ask `findUntranslated` (from `@fxm/i18n/testing`) what still reads as plain English, ignoring the test's data:

```ts
expect(findUntranslated(document.body, { ignore: [track.title, track.artist] })).toEqual([])
```

`strictReporters` make a test fail on a missing translation or a value the code forgot. In CI, `checkSource` checks the English messages (syntax, plural forms, key names) and `checkCatalog` each translation (it parses, takes the same values, keeps the tags, has every plural form its language needs).

## Tools

```sh
scripts/run.sh pnpm --filter @fxm/i18n inventory                 # hard-coded strings per app and area (Markdown)
scripts/run.sh pnpm --filter @fxm/i18n inventory --list home     # the strings of matching areas
scripts/run.sh pnpm --filter @fxm/i18n inventory --json          # everything
scripts/run.sh pnpm --filter @fxm/i18n size                      # what each entry adds to a bundle
```

[`tools/strings.ts`](tools/strings.ts) decides what counts as a hard-coded user-facing string, [`tools/inventory.ts`](tools/inventory.ts) walks the apps. [`tools/size.ts`](tools/size.ts) bundles each entry with rolldown (Vite 8's bundler), minified, and compresses it with brotli at quality 4, as stage 8.5a's budgets measure; `tools/size.test.ts` holds the budgets.

| Entry | Minified | Brotli | Budget |
|---|---|---|---|
| core (`createI18n` and negotiation) | 9,154 B | 3,745 B | 4,100 B |
| core and React bindings | 9,960 B | 4,066 B | 4,500 B |
| every formatter | 2,697 B | 1,179 B | 1,300 B |
| pseudo-locales | 733 B | 600 B | 700 B |

```sh
scripts/run.sh pnpm vitest run packages/i18n   # unit, type-level, size and inventory tests (offline)
```
