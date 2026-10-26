/**
 * Formats parsed messages (`parse.ts`) with values, for a locale: as text, or as parts whose tags
 * a renderer turns into elements.
 *
 * @module
 */

import { dateTimeFormat, numberFormat, pluralRules } from './intl'
import type { MessageNode, MessageOptions } from './parse'

/** Values for a message's arguments, by name. */
export type Values = Readonly<Record<string, unknown>>

/** What went wrong with a value: the message shows `{name}` in its place. */
export interface ValueProblem {
  /** `missing`: no value; `type`: a value of the wrong kind, such as text for a plural. */
  readonly kind: 'missing' | 'type'
  /** The argument's name. */
  readonly name: string
}

/** How to format a message. */
export interface FormatOptions<T> {
  /** The locale for numbers, dates and plural rules. */
  readonly locale: string
  readonly values?: Values | undefined
  /**
   * Renders a tag around its content. Without it, or when it returns `undefined`, a tag leaves
   * only its content.
   */
  readonly tag?: ((name: string, children: (string | T)[]) => string | T | undefined) | undefined
  /** Told about each missing or unusable value. */
  readonly onProblem?: ((problem: ValueProblem) => void) | undefined
}

/** Formats `nodes` into parts: strings (adjacent ones joined) and what `options.tag` returns. */
export function formatToParts<T>(
  nodes: readonly MessageNode[],
  options: FormatOptions<T>,
): (string | T)[] {
  const { locale, values = {}, tag, onProblem } = options

  const problem = (kind: ValueProblem['kind'], name: string): string => {
    onProblem?.({ kind, name })
    return `{${name}}`
  }

  const numeric = (name: string): number | undefined => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined
    if (typeof value === 'number' && !Number.isNaN(value)) return value
    problem(value === undefined ? 'missing' : 'type', name)
    return undefined
  }

  const pick = (choices: MessageOptions, selector: string): readonly MessageNode[] =>
    (Object.hasOwn(choices, selector) ? choices[selector] : choices.other) ?? []

  const render = (list: readonly MessageNode[], pound: number | undefined): (string | T)[] => {
    const out: (string | T)[] = []
    const push = (part: string | T): void => {
      const last = out.length - 1
      const previous = out[last]
      if (typeof part === 'string' && typeof previous === 'string') out[last] = previous + part
      else if (part !== '') out.push(part)
    }
    for (const node of list) {
      if (typeof node === 'string') {
        push(node)
        continue
      }
      switch (node.type) {
        case 'value': {
          const value = Object.hasOwn(values, node.name) ? values[node.name] : undefined
          if (value === undefined || value === null) push(problem('missing', node.name))
          else if (typeof value === 'number') push(numberFormat(locale).format(value))
          else if (value instanceof Date)
            push(dateTimeFormat(locale, { dateStyle: 'medium' }).format(value))
          else push(String(value))
          break
        }
        case 'number': {
          const value = numeric(node.name)
          if (value === undefined) push(`{${node.name}}`)
          else {
            const style: Intl.NumberFormatOptions | undefined =
              node.style === 'percent'
                ? { style: 'percent' }
                : node.style === 'integer'
                  ? { maximumFractionDigits: 0 }
                  : undefined
            push(numberFormat(locale, style).format(value))
          }
          break
        }
        case 'date':
        case 'time': {
          const value = Object.hasOwn(values, node.name) ? values[node.name] : undefined
          if (typeof value === 'number' || value instanceof Date) {
            const style =
              node.type === 'date' ? { dateStyle: node.style } : { timeStyle: node.style }
            push(dateTimeFormat(locale, style).format(value))
          } else push(problem(value === undefined ? 'missing' : 'type', node.name))
          break
        }
        case 'plural': {
          const value = numeric(node.name)
          if (value === undefined) {
            push(`{${node.name}}`)
            break
          }
          const exact = `=${value}`
          const choice = Object.hasOwn(node.options, exact)
            ? exact
            : pluralRules(locale, node.ordinal ? 'ordinal' : 'cardinal').select(value)
          for (const part of render(pick(node.options, choice), value)) push(part)
          break
        }
        case 'select': {
          const value = Object.hasOwn(values, node.name) ? values[node.name] : undefined
          if (value === undefined) problem('missing', node.name)
          for (const part of render(pick(node.options, String(value)), pound)) push(part)
          break
        }
        case 'pound':
          push(pound === undefined ? '#' : numberFormat(locale).format(pound))
          break
        case 'tag': {
          const children = render(node.children, pound)
          const rendered = tag?.(node.name, children)
          if (rendered === undefined) for (const part of children) push(part)
          else push(rendered)
          break
        }
      }
    }
    return out
  }

  return render(nodes, undefined)
}

/** Formats `nodes` as text: tags keep only their content. */
export function formatToString(
  nodes: readonly MessageNode[],
  options: Omit<FormatOptions<never>, 'tag'>,
): string {
  return formatToParts<never>(nodes, options).join('')
}
