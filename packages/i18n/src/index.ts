/**
 * `@fxm/i18n`: FXM's translations. Keyed messages in a subset of ICU MessageFormat (values,
 * plurals, selects, tags), typed from their English text; locale negotiation; formatting through
 * the platform's `Intl`; English bundled with the code that uses it and other locales loaded on
 * demand. See the package README and docs/I18N.md.
 *
 * Everything else lives in entries of its own, so an app's bundle takes only what it imports.
 *
 * @module
 */

export {
  type FormatOptions,
  formatToParts,
  formatToString,
  type ValueProblem,
  type Values,
} from './format'
export {
  type Catalog,
  createI18n,
  type DeriveMessages,
  type I18n,
  type I18nOptions,
  type MessageProblem,
  type MissingMessage,
  type Translator,
} from './i18n'
export {
  autonym,
  collator,
  compareText,
  createFormatters,
  type DateTimeStyle,
  type DurationStyle,
  dateTimeFormat,
  displayNames,
  type Formatters,
  formatBytes,
  formatDate,
  formatDuration,
  formatList,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
  formatTimeAgo,
  languageName,
  listFormat,
  numberFormat,
  pluralRules,
  relativeTimeFormat,
} from './intl'
export {
  type AnyValues,
  defineMessages,
  type MessageKey,
  type Messages,
  type MessageValues,
  type Namespace,
  type RichValues,
  type TagNames,
  type ValuesArg,
} from './messages'
export {
  applyDocumentLocale,
  type Direction,
  fallbackChain,
  type LocaleChoice,
  type NegotiateOptions,
  negotiateLocale,
  requestedLocales,
  textDirection,
} from './negotiate'
export {
  type DateNode,
  type DateStyle,
  type MessageNode,
  type MessageOptions,
  MessageSyntaxError,
  type NumberNode,
  type NumberStyle,
  PLURAL_CATEGORIES,
  type PluralNode,
  type PoundNode,
  parseMessage,
  type SelectNode,
  type TagNode,
  type ValueNode,
} from './parse'
