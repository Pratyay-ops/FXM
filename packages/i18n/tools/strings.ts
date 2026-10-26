/**
 * Finds hard-coded user-facing text in FXM's sources, to size the conversion to messages (phase 2
 * of docs/I18N.md). It parses each file and counts what would become one message:
 *
 * - `text`: a run of JSX or HTML text, with the inline elements (`<a>`, `<strong>`, `<Link>`…)
 *   and `{expressions}` inside it, so "Read the <a>notes</a> first, {name}." is one message;
 * - `attribute`: an attribute people read or hear (`aria-label`, `title`, `alt`, `placeholder`,
 *   and copy props such as `label`, `description`, `hint`), as a literal or a template;
 * - `code`: a string or template in code that reads as prose: toasts, error states, labels in
 *   tables, route titles. Single words count only where copy is expected (a `label:` property, a
 *   `*_LABELS` table, a `showStatus()` call, a JSX expression);
 * - `error`: the message of an `Error` that code throws, which may reach the screen or not;
 * - `resource`: a string already in a platform's resource file (Android's `strings.xml`);
 * - `document`: a paragraph or list item of a long text, such as a store listing.
 *
 * It skips what is clearly not copy: class lists, URLs, paths, identifiers, MIME types, storage
 * keys, imports, `console` calls, comparisons, object keys, types, and arguments of DOM and string
 * APIs. Heuristics are imperfect; docs/I18N.md gives the measured precision.
 *
 * @module
 */

import { parse as parseAstro } from '@astrojs/compiler-rs'
import { parseAst } from 'rolldown/parseAst'

/** What kind of string a finding is: see the module's notes. */
export type Category = 'text' | 'attribute' | 'code' | 'error' | 'resource' | 'document'

/** One string that would become a message. */
export interface Finding {
  readonly category: Category
  /** The text, with `{}` for each value put into it and `<>` around inline elements. */
  readonly text: string
  readonly line: number
}

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from two parsers, read structurally
type AnyNode = any

/** Attributes and props that hold copy, whatever their value looks like. */
export const COPY_ATTRIBUTES: ReadonlySet<string> = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'placeholder',
  'title',
  // Props of FXM's components that end up on screen or in an aria-label.
  'actionLabel',
  'cancelLabel',
  'caption',
  'confirmLabel',
  'description',
  'emptyLabel',
  'emptyText',
  'heading',
  'help',
  'hint',
  'label',
  'message',
  'noun',
  'plural',
  'singular',
  'subtitle',
  'summary',
  'text',
  'tooltip',
])

/** Object properties that hold copy: their string values count even as one word. */
export const COPY_KEYS: ReadonlySet<string> = new Set([
  ...COPY_ATTRIBUTES,
  'about',
  'and',
  'answer',
  'body',
  'button',
  'buttonLabel',
  'cancel',
  'confirm',
  'detail',
  'details',
  'empty',
  'emptyTitle',
  'how',
  'intro',
  'lead',
  'link',
  'linkLabel',
  'name',
  'note',
  'notice',
  'or',
  'other',
  'question',
  'reason',
  'short',
  'what',
  'why',
])

/** Attributes and keys that never hold copy, whatever their value looks like. */
const CODE_KEYS: ReadonlySet<string> = new Set([
  'accept',
  'align',
  'allow',
  'appearance',
  'as',
  'autoCapitalize',
  'autoComplete',
  'charset',
  'class',
  'className',
  'codec',
  'color',
  'content-type',
  'crossOrigin',
  'd',
  'dir',
  'enterKeyHint',
  'event',
  'fill',
  'format',
  'href',
  'htmlFor',
  'icon',
  'id',
  'inputMode',
  'key',
  'kind',
  'lang',
  'layout',
  'loading',
  'media',
  'method',
  'mime',
  'mimeType',
  'mode',
  'pattern',
  'referrerPolicy',
  'rel',
  'role',
  'rounded',
  'sandbox',
  'shape',
  'size',
  'sizes',
  'slot',
  'src',
  'srcSet',
  'stroke',
  'style',
  'target',
  'testId',
  'theme',
  'to',
  'tone',
  'transform',
  'type',
  'url',
  'value',
  'variant',
  'viewBox',
  'xmlns',
])

/** Attributes that never hold copy, besides {@link CODE_KEYS}: the meta handler reads `content`. */
const CODE_ATTRIBUTES: ReadonlySet<string> = new Set([
  ...CODE_KEYS,
  'charset',
  'content',
  'http-equiv',
  'name',
  'property',
])

/** Calls whose string arguments are copy, even one word. */
const COPY_CALLS: ReadonlySet<string> = new Set([
  'alert',
  'announce',
  'confirm',
  'countLabel',
  'notify',
  'page',
  'setBusy',
  'setError',
  'setMessage',
  'setNotice',
  'setStatus',
  'showFeedback',
  'showStatus',
  'tab',
  'toast',
])

/** Calls whose string arguments are never copy: logging, DOM, storage, string and class APIs. */
const CODE_CALLS: ReadonlySet<string> = new Set([
  'addEventListener',
  'append',
  'at',
  'clsx',
  'cn',
  'createElement',
  'createElementNS',
  'cx',
  'debug',
  'delete',
  'dispatchEvent',
  'endsWith',
  'error',
  'fetch',
  'get',
  'getAttribute',
  'getElementById',
  'getItem',
  'has',
  'hasAttribute',
  'importScripts',
  'includes',
  'indexOf',
  'info',
  'join',
  'lastIndexOf',
  'log',
  'match',
  'matchAll',
  'matchMedia',
  'padEnd',
  'padStart',
  'postMessage',
  'querySelector',
  'querySelectorAll',
  'removeAttribute',
  'removeEventListener',
  'removeItem',
  'replace',
  'replaceAll',
  'require',
  'search',
  'set',
  'setAttribute',
  'setItem',
  'setProperty',
  'split',
  'startsWith',
  'stubEnv',
  'stubGlobal',
  'toLocaleDateString',
  'toLocaleString',
  'toLocaleTimeString',
  'trace',
  'twMerge',
  'warn',
])

/** Constructors whose string arguments are never copy. */
const CODE_CONSTRUCTORS: ReadonlySet<string> = new Set([
  'BroadcastChannel',
  'CustomEvent',
  'Event',
  'Headers',
  'Intl',
  'RegExp',
  'Request',
  'Response',
  'URL',
  'URLSearchParams',
  'Worker',
])

/** Elements that stay inside a run of text: one message covers them. */
const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
  // FXM's inline components.
  'ExternalLink',
  'Kbd',
  'Link',
  'NavLink',
])

/** Elements whose content is never copy. */
const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(['style', 'svg', 'path', 'code', 'pre'])

const LETTER = /\p{L}/u

/** A class list, as Tailwind writes it: most tokens have `-`, `:`, `/` or brackets. */
function looksLikeClasses(tokens: readonly string[]): boolean {
  if (tokens.some((token) => /[A-Z]/.test(token.replace(/\[[^\]]*\]/g, '')))) return false
  if (tokens.some((token) => /[,.!?;'"’]$/.test(token))) return false
  const technical = tokens.filter((token) => /[-:/[\]@&>]/.test(token)).length
  return technical * 2 >= tokens.length
}

/** Whether `text` is clearly code: a URL, path, selector, identifier, MIME type, schema or CSS. */
export function looksLikeCode(text: string): boolean {
  const trimmed = text.trim()
  if (!LETTER.test(trimmed)) return true
  if (/^(https?:|mailto:|data:|blob:|wss?:|file:|\/|\.{1,2}\/|#|@|\[|\$\{|::)/.test(trimmed))
    return true
  // MIME types, with parameters: `audio/webm; codecs="opus"`.
  if (/^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w-]+=("[^"]*"|[\w.-]+))*$/.test(trimmed)) return true
  // Content security policies, user agents and markup.
  if (
    /(^|\s)'(self|none|unsafe-[\w-]+|strict-dynamic|wasm-unsafe-eval)'|(^|;\s*)[a-z-]+-src\s/.test(
      trimmed,
    )
  ) {
    return true
  }
  // A product token starts a user agent: `Mozilla/5.0 (…)`, `FXM/{} (…)` (values may be blanked).
  if (/^\w+\/(\d|\{\}|\s)/.test(trimmed) || (trimmed.match(/\b\w+\/\d+\.\d+/g)?.length ?? 0) >= 2) {
    return true
  }
  if (/^<[a-zA-Z][\w:-]*\s+[\w:-]+=/.test(trimmed)) return true
  if (
    /^<\??[a-zA-Z][\w:-]*(\s+[\w:-]+=("[^"]*"|'[^']*'))*\s*\/?>/.test(trimmed) &&
    /=|^<(svg|defs|\?xml)/.test(trimmed)
  ) {
    return true
  }
  if (/[{};]\s*$|=>|&&|\|\||===|\(\)/.test(trimmed)) return true
  // SVG path data: `M4.5 4h15A1.5 1.5 0 0 1 21 5.5v13Z`.
  if (/^[Mm][\d\s.,MmZzLlHhVvCcSsQqTtAa-]*$/.test(trimmed) && /\d/.test(trimmed)) return true
  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 1)
    return !/^[\p{Lu}][\p{Ll}’']+[.!?…]?$/u.test(trimmed) || /^[A-Z][a-z]+[A-Z]/.test(trimmed)
  if (looksLikeClasses(tokens)) return true
  // Comma lists of single identifiers: database schemas, header names, font stacks. A list of
  // plain words ("Songs, artists, albums") is prose.
  const parts = trimmed.split(',')
  return (
    parts.length > 1 &&
    parts.every((part) => /^\s*[+&*]{0,2}\[?[\w+.-]+\]?\s*$/.test(part)) &&
    parts.some((part) => /[+&*[\].-]|[a-z][A-Z]/.test(part.trim()))
  )
}

/** Whether `text` reads as prose: two or more words, not code. */
export function looksLikeProse(text: string): boolean {
  const trimmed = text.trim()
  return (
    /\p{L}[\s\S]*\s[\s\S]*\p{L}/u.test(trimmed) && !NAMES.has(trimmed) && !looksLikeCode(trimmed)
  )
}

/** Names that stay as they are in every language, when a string is nothing else. */
const NAMES: ReadonlySet<string> = new Set([
  'Android',
  'Brave',
  'Chrome',
  'Chromium',
  'Edge',
  'Firefox',
  'FXM Connect',
  'GitHub',
  'Internet Archive',
  'Jamendo',
  'Last.fm',
  'Linux',
  'ListenBrainz',
  'LRCLIB',
  'macOS',
  'MusicBrainz',
  'Opera',
  'Safari',
  'Samsung Internet',
  'SponsorBlock',
  'Spotify',
  'Vivaldi',
  'Windows',
  'YouTube',
  'YouTube Music',
])

/**
 * Whether `text` is copy where copy is expected: prose, or one word that isn't code, an acronym
 * (`FXM`, `FLAC`), a brand written in camel case (`YouTube`) or a name ({@link NAMES}).
 */
function looksLikeCopy(text: string): boolean {
  const trimmed = text.trim()
  if (!LETTER.test(trimmed) || NAMES.has(trimmed)) return false
  if (looksLikeProse(trimmed)) return true
  if (/\s/.test(trimmed)) return false
  if (/^[\p{Lu}\d]+$/u.test(trimmed)) return false
  if (/^[A-Z][a-z]+[A-Z]/.test(trimmed)) return false
  if (/^(https?:|\/|\.|#|@)/.test(trimmed)) return false
  return (
    /^\p{L}[\p{Ll}’']*(-\p{L}[\p{Ll}’']*)*[.!?…]?$/u.test(trimmed) &&
    !/^[a-z]+(-[a-z]+)+$/.test(trimmed)
  )
}

/** The name of a JSX element or attribute. */
function jsxName(node: AnyNode): string {
  if (node === null || node === undefined) return ''
  if (node.type === 'JSXIdentifier') return node.name
  if (node.type === 'JSXNamespacedName') return `${node.namespace.name}:${node.name.name}`
  if (node.type === 'JSXMemberExpression')
    return `${jsxName(node.object)}.${jsxName(node.property)}`
  return ''
}

/** The last name of a callee: `showStatus` for `showStatus()` and `x.showStatus()`. */
function calleeName(node: AnyNode): string {
  if (node === null || node === undefined) return ''
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression' && !node.computed) return node.property?.name ?? ''
  if (node.type === 'ChainExpression') return calleeName(node.expression)
  return ''
}

/** The name of a property's key, if it is a plain name or string. */
function keyName(node: AnyNode): string | undefined {
  if (node?.type === 'Identifier') return node.name
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  return undefined
}

/** A template literal's text, with `{}` for each expression. */
function templateText(node: AnyNode): string {
  return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join('{}')
}

/** Text as people read it: runs of white space as one space. */
const squeeze = (text: string): string => text.replace(/\s+/g, ' ')

/** Positions to line numbers. */
function lineIndex(source: string): (offset: number) => number {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1)
  }
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if ((starts[middle] as number) <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }
}

/** How a string is used, from its ancestors: decides whether it is copy. */
type Usage = 'skip' | 'copy' | 'error' | 'attribute' | 'prose'

/** Variables and functions whose string is copy: `const title = …`, `tierLabel()`. */
const COPY_NAME =
  /(label|text|title|message|caption|hint|summary|description|heading|copy|notice)s?$/i

/** Tables whose entries are copy: `TRACK_KIND_LABELS`, `errorMessages`. */
const COPY_TABLE = /(labels|texts|titles|messages|names|captions|hints|descriptions|copy|strings)$/i

/** The object initializer of a variable named like a copy table, past `as const` and `satisfies`. */
function isCopyTable(path: readonly AnyNode[], objectIndex: number): boolean {
  let index = objectIndex - 1
  while (
    index >= 0 &&
    ['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion'].includes(path[index].type)
  ) {
    index -= 1
  }
  const holder = path[index]
  return (
    holder?.type === 'VariableDeclarator' &&
    holder.id?.type === 'Identifier' &&
    COPY_TABLE.test(holder.id.name)
  )
}

/** How the string at the end of `path` (ancestors, nearest last) is used. */
function usageOf(path: readonly AnyNode[]): Usage {
  const node = path[path.length - 1]
  for (let index = path.length - 2; index >= 0; index -= 1) {
    const parent = path[index]
    const child = path[index + 1]
    switch (parent.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
      case 'ImportExpression':
      case 'TSLiteralType':
      case 'TSEnumMember':
      case 'TSImportType':
      case 'TSExternalModuleReference':
      case 'TaggedTemplateExpression':
        return 'skip'
      case 'SwitchCase':
        if (parent.test === child) return 'skip'
        break
      case 'ExpressionStatement':
        if (parent.directive !== undefined && parent.directive !== null) return 'skip'
        return 'prose'
      case 'BinaryExpression':
        if (['===', '!==', '==', '!=', 'in', 'instanceof'].includes(parent.operator)) return 'skip'
        break
      case 'MemberExpression':
        if (parent.computed && parent.property === child) return 'skip'
        break
      case 'Property': {
        if (parent.key === child) return 'skip'
        const key = parent.computed ? undefined : keyName(parent.key)
        if (key !== undefined && CODE_KEYS.has(key)) return 'skip'
        if (key !== undefined && COPY_KEYS.has(key)) return 'copy'
        // Another key: copy in a table of copy, else prose only.
        return path[index - 1]?.type === 'ObjectExpression' && isCopyTable(path, index - 1)
          ? 'copy'
          : 'prose'
      }
      case 'JSXAttribute': {
        const name = jsxName(parent.name)
        if (CODE_ATTRIBUTES.has(name) || name.startsWith('data-') || name.startsWith('on'))
          return 'skip'
        if (COPY_ATTRIBUTES.has(name)) return 'attribute'
        if (name.startsWith('aria-')) return 'skip'
        return 'prose'
      }
      case 'JSXExpressionContainer':
        // An attribute's value is the attribute's to judge; a child is copy.
        if (path[index - 1]?.type === 'JSXAttribute') break
        return 'copy'
      case 'NewExpression':
      case 'CallExpression': {
        if (parent.callee === child) break
        const name = calleeName(parent.callee)
        if (parent.type === 'NewExpression' && /Error$/.test(name)) return 'error'
        if (parent.type === 'NewExpression' && CODE_CONSTRUCTORS.has(name)) return 'skip'
        if (name === 'Error' || name === 'reject') return 'error'
        if (parent.callee?.type === 'MemberExpression' && parent.callee.object?.name === 'console')
          return 'skip'
        if (CODE_CALLS.has(name) || name === 'Symbol' || name === 'import') return 'skip'
        if (COPY_CALLS.has(name)) return 'copy'
        return 'prose'
      }
      case 'ThrowStatement':
        return 'error'
      case 'VariableDeclarator':
        if (
          parent.init === child &&
          parent.id?.type === 'Identifier' &&
          COPY_NAME.test(parent.id.name)
        ) {
          return 'copy'
        }
        return 'prose'
      case 'ArrayExpression':
        if (
          path[index - 1]?.type === 'VariableDeclarator' &&
          COPY_TABLE.test(path[index - 1].id?.name ?? '')
        ) {
          return 'copy'
        }
        break
      case 'ReturnStatement':
      case 'ArrowFunctionExpression': {
        // The function that returns it: `function tierLabel() { return 'Full' }`.
        for (let outer = index; outer >= 0; outer -= 1) {
          const holder = path[outer]
          const name =
            holder.type === 'FunctionDeclaration'
              ? holder.id?.name
              : holder.type === 'VariableDeclarator'
                ? holder.id?.name
                : holder.type === 'Property' || holder.type === 'MethodDefinition'
                  ? keyName(holder.key)
                  : undefined
          if (name !== undefined) return COPY_NAME.test(name) ? 'copy' : 'prose'
        }
        return 'prose'
      }
      case 'AssignmentExpression':
        if (
          parent.left?.type === 'MemberExpression' &&
          ['textContent', 'title', 'innerText', 'placeholder'].includes(parent.left.property?.name)
        ) {
          return 'copy'
        }
        return 'prose'
      default:
        break
    }
  }
  return node === undefined ? 'skip' : 'prose'
}

/** Finds the copy in a parsed program or Astro document. */
function scanTree(root: AnyNode, line: (offset: number) => number): Finding[] {
  const findings: Finding[] = []
  /** JSX text and literals already counted as part of a run or an attribute. */
  const counted = new Set<AnyNode>()
  /** Inline elements absorbed into their parent's run. */
  const absorbed = new Set<AnyNode>()

  const add = (category: Category, text: string, node: AnyNode): void => {
    const shown = squeeze(text).trim()
    if (shown !== '') findings.push({ category, text: shown, line: line(node.start ?? 0) })
  }

  /** The text of an inline element absorbed into a run, marking what it holds as counted. */
  const inlineText = (element: AnyNode): string => {
    absorbed.add(element)
    let text = ''
    for (const child of element.children ?? []) {
      if (child.type === 'JSXText') {
        counted.add(child)
        text += child.value
      } else if (child.type === 'JSXExpressionContainer') {
        const expression = child.expression
        if (expression?.type === 'Literal' && typeof expression.value === 'string') {
          counted.add(expression)
          text += expression.value
        } else if (expression?.type !== 'JSXEmptyExpression') text += '{}'
      } else if (
        child.type === 'JSXElement' &&
        INLINE_ELEMENTS.has(jsxName(child.openingElement.name))
      ) {
        text += `<>${inlineText(child)}</>`
      }
    }
    return text
  }

  /** Counts the runs of text among an element's children. */
  const runs = (element: AnyNode): void => {
    if (absorbed.has(element)) return
    const name = element.type === 'JSXElement' ? jsxName(element.openingElement.name) : ''
    if (SKIPPED_ELEMENTS.has(name) || name === 'script') return
    let text = ''
    let start: AnyNode
    let hasText = false
    let expressions: AnyNode[] = []
    const close = (): void => {
      const plain = squeeze(text.replace(/<\/?>/g, '')).trim()
      if (hasText && LETTER.test(text) && plain !== 'FXM' && plain !== '{}' && !NAMES.has(plain)) {
        add('text', text, start)
        // A run holds the strings of its expressions: `Pick {n} more {n === 1 ? 'artist' : 'artists'}`.
        for (const expression of expressions) counted.add(expression)
      }
      text = ''
      hasText = false
      expressions = []
    }
    for (const child of element.children ?? []) {
      if (child.type === 'JSXText') {
        if (child.value.trim() === '') {
          if (text !== '') text += ' '
          continue
        }
        if (text === '') start = child
        counted.add(child)
        text += child.value
        hasText = true
      } else if (child.type === 'JSXExpressionContainer') {
        const expression = child.expression
        if (expression?.type === 'JSXEmptyExpression') continue
        if (expression?.type === 'Literal' && typeof expression.value === 'string') {
          if (text === '') start = child
          counted.add(expression)
          text += expression.value
          if (LETTER.test(expression.value)) hasText = true
        } else if (text !== '') {
          text += '{}'
          expressions.push(child)
        }
      } else if (
        child.type === 'JSXElement' &&
        INLINE_ELEMENTS.has(jsxName(child.openingElement.name))
      ) {
        const inner = inlineText(child)
        if (text === '') start = child
        text += `<>${inner}</>`
        if (LETTER.test(inner)) hasText = true
      } else close()
    }
    close()
  }

  const visit = (node: AnyNode, path: AnyNode[]): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path)
      return
    }
    if (typeof node.type !== 'string') return
    const next = [...path, node]
    switch (node.type) {
      case 'JSXElement': {
        const name = jsxName(node.openingElement.name)
        if (SKIPPED_ELEMENTS.has(name)) return
        if (name === 'meta') {
          const attributes = node.openingElement.attributes
          const named = attributes.find((attribute: AnyNode) =>
            ['name', 'property'].includes(jsxName(attribute.name)),
          )
          const content = attributes.find(
            (attribute: AnyNode) => jsxName(attribute.name) === 'content',
          )
          const which = named?.value?.value
          if (
            typeof which === 'string' &&
            /description|title|og:|twitter:|apple-mobile-web-app-title/.test(which)
          ) {
            if (content?.value?.type === 'Literal' && looksLikeCopy(content.value.value)) {
              counted.add(content.value)
              add('attribute', content.value.value, content)
            }
          }
        }
        runs(node)
        break
      }
      case 'JSXFragment':
        runs(node)
        break
      case 'JSXAttribute': {
        const name = jsxName(node.name)
        const value = node.value
        const literal =
          value?.type === 'Literal'
            ? value
            : value?.type === 'JSXExpressionContainer' &&
                (value.expression?.type === 'Literal' ||
                  value.expression?.type === 'TemplateLiteral')
              ? value.expression
              : undefined
        const judged =
          !CODE_ATTRIBUTES.has(name) && !name.startsWith('data-') && !name.startsWith('on')
        if (
          literal !== undefined &&
          judged &&
          (COPY_ATTRIBUTES.has(name) || !name.startsWith('aria-'))
        ) {
          const text = literal.type === 'TemplateLiteral' ? templateText(literal) : literal.value
          if (typeof text === 'string') {
            counted.add(literal)
            const bare = text.replaceAll('{}', ' ')
            if (COPY_ATTRIBUTES.has(name) ? looksLikeCopy(bare) : looksLikeProse(bare)) {
              add('attribute', text, literal)
            }
          }
        }
        break
      }
      case 'Literal':
      case 'TemplateLiteral': {
        if (counted.has(node)) return
        const text = node.type === 'TemplateLiteral' ? templateText(node) : node.value
        if (typeof text !== 'string' || !LETTER.test(text)) break
        // Part of a message counted already: "Pick {} more {}" holds its 'artist' and 'artists'.
        if (path.some((outer) => counted.has(outer))) break
        const use = usageOf(next)
        const bare = text.replaceAll('{}', ' ')
        let category: Category | undefined
        if (use === 'error') category = looksLikeProse(bare) ? 'error' : undefined
        else if (use === 'copy' || use === 'attribute') {
          category = looksLikeCopy(bare) ? (use === 'attribute' ? 'attribute' : 'code') : undefined
        } else if (use === 'prose') category = looksLikeProse(bare) ? 'code' : undefined
        if (category !== undefined) {
          add(category, text, node)
          counted.add(node)
        }
        break
      }
      default:
        break
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || value === null || typeof value !== 'object') continue
      visit(value, next)
    }
  }

  visit(root, [])
  return findings
}

/** The copy in a TypeScript or TSX module. */
export function scanScript(source: string, file: string): Finding[] {
  const lang = file.endsWith('.tsx')
    ? 'tsx'
    : file.endsWith('.jsx')
      ? 'jsx'
      : /\.m?js$/.test(file)
        ? 'js'
        : 'ts'
  return scanTree(parseAst(source, { lang }, file), lineIndex(source))
}

/** The copy in an Astro component or an HTML document (which Astro's parser reads too). */
export function scanAstro(source: string): Finding[] {
  const { ast } = parseAstro(source)
  return scanTree(ast, lineIndex(source))
}

/** A string literal in Rust, Kotlin or Java source, with where it starts. */
interface StringLiteral {
  readonly text: string
  readonly start: number
}

/**
 * The string literals of Rust, Kotlin or Java source, skipping comments and char literals (`'"'`),
 * with raw strings (`r#"…"#`, Kotlin's `"""…"""`) read as they are and escapes undone.
 */
export function stringLiterals(source: string): StringLiteral[] {
  const found: StringLiteral[] = []
  let at = 0
  while (at < source.length) {
    const char = source[at]
    const next = source[at + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', at)
      at = end === -1 ? source.length : end
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', at + 2)
      at = end === -1 ? source.length : end + 2
    } else if (char === "'") {
      // A char literal ('x', '\n', '\u{1F3B5}'), else a Rust lifetime ('a), which is skipped.
      const literal = /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'\n])'/.exec(source.slice(at, at + 12))
      at += literal === null ? 1 : literal[0].length
    } else if (
      char === 'r' &&
      /^r#*"/.test(source.slice(at, at + 8)) &&
      !/\w/.test(source[at - 1] ?? '')
    ) {
      const hashes = (/^r(#*)"/.exec(source.slice(at)) as RegExpExecArray)[1] as string
      const open = at + 2 + hashes.length
      const end = source.indexOf(`"${hashes}`, open)
      const close = end === -1 ? source.length : end
      found.push({ text: source.slice(open, close), start: at })
      at = close + 1 + hashes.length
    } else if (char === '"' && source.startsWith('"""', at)) {
      const end = source.indexOf('"""', at + 3)
      const close = end === -1 ? source.length : end
      found.push({ text: source.slice(at + 3, close), start: at })
      at = close + 3
    } else if (char === '"') {
      let text = ''
      let index = at + 1
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const escaped = source[index + 1] ?? ''
          text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
          index += 2
        } else {
          text += source[index]
          index += 1
        }
      }
      found.push({ text, start: at })
      at = index + 1
    } else at += 1
  }
  return found
}

/** The copy in Rust: prose literals outside comments, tests and log or error calls. */
export function scanRust(source: string): Finding[] {
  const findings: Finding[] = []
  const line = lineIndex(source)
  const tests = source.search(/#\[cfg\(test\)\]/)
  const code = tests === -1 ? source : source.slice(0, tests)
  for (const { text, start } of stringLiterals(code)) {
    const before = code.slice(Math.max(0, start - 60), start)
    if (
      /(log::\w+!|println!|eprintln!|debug!|info!|warn!|error!|trace!|panic!|\.expect)\(\s*$/.test(
        before,
      )
    )
      continue
    const shown = text.replace(/\{[\w.:?]*\}/g, '{}')
    if (
      /\b(Err|map_err|Error::new|io::Error|format_err|bail!)\s*\(\s*(\|[^|]*\|\s*)?(format!\()?\s*$/.test(
        before,
      )
    ) {
      if (looksLikeProse(shown.replaceAll('{}', ' '))) {
        findings.push({ category: 'error', text: squeeze(shown).trim(), line: line(start) })
      }
      continue
    }
    const word =
      /^\p{Lu}/u.test(text) &&
      looksLikeCopy(text) &&
      /(text\(|&str = |\{\s*|else\s*\{\s*)$/.test(before)
    if (looksLikeProse(shown.replaceAll('{}', ' ')) || word) {
      findings.push({ category: 'code', text: squeeze(shown).trim(), line: line(start) })
    }
  }
  return findings
}

/** The copy in Kotlin or Java: what UI calls show; other prose goes to developers (errors, logs). */
export function scanJvm(source: string): Finding[] {
  const findings: Finding[] = []
  const line = lineIndex(source)
  const ui =
    /(setTitle|setMessage|setContentTitle|setContentText|setTicker|setName|setDescription|makeText|NotificationChannel|setPositiveButton|setNegativeButton)\s*\([^"]*$/
  for (const { text, start } of stringLiterals(source)) {
    const shown = text.replace(/\$\{[^}]*\}|\$\w+/g, '{}')
    if (!looksLikeProse(shown.replaceAll('{}', ' '))) continue
    const before = source.slice(Math.max(0, start - 120), start)
    findings.push({
      category: ui.test(before) ? 'code' : 'error',
      text: squeeze(shown).trim(),
      line: line(start),
    })
  }
  return findings
}

/** The translatable strings of an Android `strings.xml`: `<string>` and `<plurals>`. */
export function scanAndroidStrings(source: string): Finding[] {
  const findings: Finding[] = []
  const line = lineIndex(source)
  for (const match of source.matchAll(
    /<(string|plurals)\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g,
  )) {
    if (/translatable="false"/.test(match[3] ?? '')) continue
    const body = (match[4] ?? '').replace(/<[^>]+>/g, ' ')
    const text = body.trim()
    if (!LETTER.test(text) || /^[a-z]\w*(\.\w+)+$/i.test(text) || /^[\p{Lu}\d]+$/u.test(text))
      continue
    findings.push({
      category: 'resource',
      text: squeeze(body).trim(),
      line: line(match.index ?? 0),
    })
  }
  return findings
}

/** A long text's paragraphs and list items, each a message for translators. */
export function scanDocument(source: string): Finding[] {
  const findings: Finding[] = []
  const line = lineIndex(source)
  let offset = 0
  for (const block of source.split(/\n\s*\n/)) {
    const at = source.indexOf(block, offset)
    offset = at + block.length
    const items = block.split(/\n(?=\s*[-*] )/)
    let itemOffset = at
    for (const item of items) {
      const text = item.replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '')
      if (LETTER.test(text))
        findings.push({ category: 'document', text: squeeze(text).trim(), line: line(itemOffset) })
      itemOffset += item.length + 1
    }
  }
  return findings
}

/** The number of words in `text`, for translation effort. */
export function wordCount(text: string): number {
  return text
    .replaceAll('{}', ' ')
    .split(/[\s<>/]+/)
    .filter((word) => LETTER.test(word)).length
}
