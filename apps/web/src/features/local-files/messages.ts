/**
 * Words for what went wrong with local files.
 *
 * @module
 */

import { isFxmError } from '@fxm/core'
import { isPermissionError } from './file-system'

/** The words to show when adding, scanning or opening local files failed. */
export function localFailureText(error: unknown): string {
  // FXM's own errors about local files say what happened and what to do.
  if (isFxmError(error)) return error.message
  if (isPermissionError(error)) return 'The browser didn’t let FXM read that folder'
  return 'Something went wrong with your local files. Try again.'
}
