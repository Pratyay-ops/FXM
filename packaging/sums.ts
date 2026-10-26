/**
 * A release's `SHA256SUMS` (docs/WORKFLOW.md, "Releases"): one `<sha256>  <file>` line per
 * file, as `sha256sum` writes them. The winget and Flatpak generators take the installers'
 * checksums from it, so they name exactly what the release published.
 *
 * @module
 */

/** The checksums, by file name, in lower case. Throws on a line it can't read. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    const match = /^([\da-fA-F]{64}) [ *]([^/\\]+)$/.exec(line.trimEnd())
    if (!match) throw new Error(`SHA256SUMS, line ${index + 1}: expected "<sha256>  <file>"`)
    const [, sum, name] = match as unknown as [string, string, string]
    if (sums.has(name)) throw new Error(`SHA256SUMS lists ${name} twice`)
    sums.set(name, sum.toLowerCase())
  }
  return sums
}

/** The checksum of `file`, or an error that names what the release has instead. */
export function sumOf(sums: ReadonlyMap<string, string>, file: string): string {
  const sum = sums.get(file)
  if (sum === undefined) {
    throw new Error(
      `SHA256SUMS has no ${file}: the release holds ${[...sums.keys()].join(', ') || 'nothing'}`,
    )
  }
  return sum
}
