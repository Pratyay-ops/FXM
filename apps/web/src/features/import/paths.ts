/** The Import page. */
export const IMPORT_PATH = '/import'

/** The page of one import: its review list and match report. */
export function importPath(id: string): string {
  return `${IMPORT_PATH}/${encodeURIComponent(id)}`
}
