/**
 * Why an import file or link cannot be used. Parsers throw an {@link ImportInputError} with a
 * code the app turns into a message; everything else that goes wrong inside a file (a bad row,
 * an episode) is counted in `ParsedImport.skipped` instead.
 *
 * @module
 */

/**
 * Why an input cannot be imported:
 *
 * - `empty`: nothing in it
 * - `too-large`: larger than an import reads
 * - `no-title-column`: a CSV file without a column of song titles
 * - `no-tracks`: readable, but no song in it
 * - `not-spotify-export`: none of the files is part of Spotify's data export
 * - `bad-zip`: a ZIP file that cannot be read (damaged, encrypted or ZIP64)
 * - `zip-unsupported`: this browser cannot unpack ZIP files; unpack it and choose the files
 * - `bad-link`: not a link FXM can import
 */
export type ImportInputErrorCode =
  | 'empty'
  | 'too-large'
  | 'no-title-column'
  | 'no-tracks'
  | 'not-spotify-export'
  | 'bad-zip'
  | 'zip-unsupported'
  | 'bad-link'

/** An input that cannot be imported, with an {@link ImportInputErrorCode}. */
export class ImportInputError extends Error {
  override readonly name = 'ImportInputError'
  /** Why. */
  readonly code: ImportInputErrorCode

  constructor(code: ImportInputErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Whether `value` is an {@link ImportInputError}, optionally with `code`. */
export function isImportInputError(
  value: unknown,
  code?: ImportInputErrorCode,
): value is ImportInputError {
  return (
    value instanceof ImportInputError &&
    (code === undefined || (value as ImportInputError).code === code)
  )
}
