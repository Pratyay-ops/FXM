/**
 * The options page as each build ships it. Elements marked `data-dev` in options.html belong to
 * the development build only: its badge, its warning about localhost and its localhost toggle.
 * The release build drops them, so its page names no localhost origin it never allows, and
 * options.ts looks them up only in the development build.
 *
 * Node runs this file directly (type stripping), which is why it imports nothing.
 */

/** A start tag with a `data-dev` attribute; the first group is the element's name. */
const DEV_START = /<([a-zA-Z][\w-]*)\b[^>]*?\sdata-dev(?=[\s=/>])[^>]*>/

/** The options page for a build: the development build keeps the `data-dev` elements. */
export function optionsPage(html: string, dev: boolean): string {
  return dev ? html : dropDevBlocks(html)
}

/**
 * Removes every element marked `data-dev`, with its contents, and the lines it had to itself.
 * Throws when a marked element has no closing tag.
 */
export function dropDevBlocks(html: string): string {
  let page = html
  for (let start = DEV_START.exec(page); start; start = DEV_START.exec(page)) {
    const name = (start[1] ?? '').toLowerCase()
    let from = start.index
    let to = elementEnd(page, name, from + start[0].length)
    const lineStart = page.lastIndexOf('\n', from - 1) + 1
    const lineEnd = page.indexOf('\n', to) === -1 ? page.length : page.indexOf('\n', to)
    if (/^[ \t]*$/.test(page.slice(lineStart, from)) && /^[ \t]*$/.test(page.slice(to, lineEnd))) {
      from = lineStart
      to = Math.min(lineEnd + 1, page.length)
    }
    page = page.slice(0, from) + page.slice(to)
  }
  // A dropped block between two blank lines leaves them both.
  return page.replace(/\n(?:[ \t]*\n){2,}/g, '\n\n')
}

/** Where the element whose start tag ends at `from` ends: after its matching closing tag. */
function elementEnd(html: string, name: string, from: number): number {
  const tags = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, 'gi')
  tags.lastIndex = from
  let depth = 1
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[1] ? -1 : 1
    if (depth === 0) return tag.index + tag[0].length
  }
  throw new Error(`options.html: <${name} data-dev> has no closing tag`)
}
