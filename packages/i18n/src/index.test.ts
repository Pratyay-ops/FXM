import { describe, expect, it } from 'vitest'
import * as i18n from './index'

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
})
