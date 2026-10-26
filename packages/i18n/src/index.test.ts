import { describe, expect, it } from 'vitest'
import * as check from './check'
import * as i18n from './index'
import * as pseudo from './pseudo'
import * as testing from './testing'

describe('@fxm/i18n', () => {
  it('exports the runtime, negotiation and formatting', () => {
    expect(Object.keys(i18n).sort()).toEqual([
      'MessageSyntaxError',
      'PLURAL_CATEGORIES',
      'applyDocumentLocale',
      'autonym',
      'collator',
      'compareText',
      'createFormatters',
      'createI18n',
      'dateTimeFormat',
      'defineMessages',
      'displayNames',
      'fallbackChain',
      'formatBytes',
      'formatDate',
      'formatDuration',
      'formatList',
      'formatNumber',
      'formatPercent',
      'formatRelativeTime',
      'formatTime',
      'formatTimeAgo',
      'formatToParts',
      'formatToString',
      'languageName',
      'listFormat',
      'negotiateLocale',
      'numberFormat',
      'parseMessage',
      'pluralRules',
      'relativeTimeFormat',
      'requestedLocales',
      'textDirection',
    ])
  })

  it('keeps the pseudo-locales, the checks and the test helpers in entries of their own', () => {
    expect(Object.keys(pseudo).sort()).toEqual([
      'PSEUDO_LOCALES',
      'PSEUDO_MARKS',
      'accentText',
      'accented',
      'bidi',
    ])
    expect(Object.keys(check).sort()).toEqual([
      'checkCatalog',
      'checkSource',
      'checkTranslation',
      'completion',
      'sourceCatalog',
      'syntaxError',
    ])
    expect(Object.keys(testing).sort()).toEqual([
      'TRANSLATED_ATTRIBUTES',
      'UNTRANSLATED_FORMAT_LOCALE',
      'findUntranslated',
      'strictReporters',
    ])
  })
})
