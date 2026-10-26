/**
 * React bindings: a provider for the app's {@link I18n}, and hooks that re-render when the locale
 * changes.
 *
 * ```tsx
 * <I18nProvider i18n={appI18n}><App /></I18nProvider>
 *
 * function LibraryTitle({ count }: { count: number }) {
 *   const t = useT(libraryMessages)
 *   return (
 *     <>
 *       <h1>{t('title')}</h1>
 *       <p>{t('songCount', { count })}</p>
 *       <p>{t.rich('removed', { title, playlist, link: (children) => <Link to={to}>{children}</Link> })}</p>
 *     </>
 *   )
 * }
 * ```
 *
 * @module
 */

import {
  createContext,
  createElement,
  Fragment,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react'
import type { I18n, Translator } from './i18n'
import { createFormatters, type Formatters } from './intl'
import type { MessageKey, Messages, Namespace, RichValues, ValuesArg } from './messages'
import type { Direction } from './negotiate'

const I18nContext = createContext<I18n | undefined>(undefined)

/** Gives the components below it the app's translations. */
export function I18nProvider({ i18n, children }: { i18n: I18n; children?: ReactNode }): ReactNode {
  return createElement(I18nContext.Provider, { value: i18n }, children)
}

/**
 * The app's translations, re-rendering the component when the locale changes or a catalog
 * arrives. Throws outside an {@link I18nProvider}.
 */
export function useI18n(): I18n {
  const i18n = useContext(I18nContext)
  if (i18n === undefined) throw new Error('useI18n() needs an <I18nProvider> above it')
  useSyncExternalStore(
    i18n.subscribe,
    () => i18n.revision,
    () => i18n.revision,
  )
  return i18n
}

/** A translator whose `rich` returns a React node (see {@link Translator}). */
export interface ReactTranslator<M extends Messages> {
  /** The message `key` with `values`, as text. Tags keep only their content. */
  <K extends MessageKey<M>>(key: K, ...values: ValuesArg<M[K]>): string
  /**
   * The message `key` with each tag rendered by the function of its name in `values`, which gets
   * the tag's content as one node: `link: (children) => <a href={url}>{children}</a>`.
   */
  rich<K extends MessageKey<M>>(key: K, values: RichValues<M[K], ReactNode, ReactNode>): ReactNode
  /** The namespace it translates. */
  readonly namespace: Namespace<M>
}

/** Parts as one node: a fragment with the parts as its children, which need no keys. */
const asNode = (parts: readonly ReactNode[]): ReactNode =>
  parts.length === 1 ? parts[0] : createElement(Fragment, null, ...parts)

/**
 * A translator for `namespace` in the current locale. Its identity changes with the locale, so
 * memoized children that take it re-render too.
 */
export function useT<M extends Messages>(namespace: Namespace<M>): ReactTranslator<M> {
  const i18n = useI18n()
  const revision = i18n.revision
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new translator for each revision
  return useMemo(() => {
    const translate = i18n.translator(namespace)
    const rich = (key: string, values: Readonly<Record<string, unknown>>): ReactNode => {
      const wrapped: Record<string, unknown> = { ...values }
      for (const [name, value] of Object.entries(values)) {
        if (typeof value === 'function') {
          wrapped[name] = (children: ReactNode[]) =>
            (value as (node: ReactNode) => ReactNode)(asNode(children))
        }
      }
      return asNode((translate.rich as (key: string, values: object) => ReactNode[])(key, wrapped))
    }
    const plain = translate as unknown as (key: string, values?: object) => string
    return Object.assign((key: string, values?: object) => plain(key, values), {
      namespace,
      rich,
    }) as unknown as ReactTranslator<M>
  }, [i18n, namespace, revision])
}

/** The locale shown, the locale formatted in, and the text direction. */
export function useLocale(): { locale: string; formatLocale: string; direction: Direction } {
  const i18n = useI18n()
  return { locale: i18n.locale, formatLocale: i18n.formatLocale, direction: i18n.direction }
}

/**
 * The formatters of the current format locale. Code in the first load can take the locale from
 * {@link useLocale} and call the functions it needs (`formatDuration`), which bundles less.
 */
export function useFormat(): Formatters {
  return createFormatters(useI18n().formatLocale)
}
