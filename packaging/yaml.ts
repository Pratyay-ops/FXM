/**
 * Writing YAML by hand, for the generators: F-Droid's metadata, winget's manifests and the
 * Flatpak manifest. The release workflow runs them with Node alone (no YAML library), and the
 * tests read their output back with one (`yaml`) to check that it says what was meant.
 *
 * @module
 */

/** Words that YAML 1.1 or 1.2 reads as something other than a string. */
const SPECIAL = /^(?:true|false|yes|no|y|n|on|off|null|~)$/i

/** Text that YAML reads as a number (decimal, float, hex, octal, binary, infinity, NaN). */
const NUMERIC =
  /^(?:[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0x[\da-f_]+|0o?[0-7_]+|0b[01_]+|[-+]?\.(?:inf|nan))$/i

/** Whether `value` holds a control character (a line break or a tab among them). */
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Whether `value` can be a plain (unquoted) scalar that YAML reads back as the same string. */
export function isPlainSafe(value: string): boolean {
  return (
    value !== '' &&
    value === value.trim() &&
    !hasControl(value) &&
    // Indicators can't start a plain scalar; `-`, `?` and `:` can when a non-space follows, as
    // in `--share=network`, but not as a document marker.
    !/^[,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/^[-?:](\s|$)/.test(value) &&
    !value.startsWith('---') &&
    !value.includes(': ') &&
    !value.includes(' #') &&
    !value.endsWith(':') &&
    !SPECIAL.test(value) &&
    !NUMERIC.test(value)
  )
}

/** A string as a YAML scalar: plain when that is safe, else single-quoted. One line only. */
export function yamlScalar(value: string): string {
  if (/[\n\r]/.test(value))
    throw new Error(`a YAML scalar here holds one line: ${JSON.stringify(value)}`)
  return isPlainSafe(value) ? value : `'${value.replaceAll("'", "''")}'`
}

/**
 * Lines of text as a literal block scalar (`|-`), indented by `indent` spaces: the text exactly,
 * line breaks included, without a final line break.
 */
export function yamlBlock(text: string, indent: number): string {
  const pad = ' '.repeat(indent)
  const lines = text.split('\n').map((line) => (line === '' ? '' : `${pad}${line.trimEnd()}`))
  return `|-\n${lines.join('\n')}`
}
