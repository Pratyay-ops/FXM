import { LibraryError } from '../../db/repo'

/** The words to show for a failed library change. */
export function failureText(error: unknown): string {
  if (error instanceof LibraryError) return error.message
  return 'That could not be saved. The browser may be out of storage space, or blocking it.'
}
