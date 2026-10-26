/**
 * The free sources the web app offers in every tier, as its copy names them: Internet Archive, and
 * Jamendo only in a build that has FXM's public Jamendo `client_id`. That one switch,
 * `VITE_FXM_JAMENDO_CLIENT_ID`, also registers the Jamendo provider (`createAppServices`) and
 * allows Jamendo's hosts in the deployed policy (scripts/build-dist). The deploy sets it from the
 * repository variable `FXM_JAMENDO_CLIENT_ID` once the owner has registered an ID and confirmed
 * Jamendo's terms (packages/sources/src/jamendo/README.md).
 *
 * @module
 */

/** Jamendo's public `client_id` from the build, or `undefined` in a build without one. */
export function buildJamendoClientId(): string | undefined {
  const id = (import.meta.env.VITE_FXM_JAMENDO_CLIENT_ID as string | undefined)?.trim()
  return id ? id : undefined
}

/** Whether this build offers Jamendo. */
export function jamendoOffered(): boolean {
  return buildJamendoClientId() !== undefined
}

/** The free sources' names, ready for a sentence. */
export interface FreeSources {
  /** "Internet Archive and Jamendo", or "Internet Archive". */
  readonly and: string
  /** "Internet Archive or Jamendo", or "Internet Archive". */
  readonly or: string
  /** Whether there are several, for the verb after them: "… work here" or "… works here". */
  readonly several: boolean
}

/** The free sources this build offers (`jamendo`: whether it offers Jamendo). */
export function freeSources(jamendo: boolean = jamendoOffered()): FreeSources {
  return jamendo
    ? { and: 'Internet Archive and Jamendo', or: 'Internet Archive or Jamendo', several: true }
    : { and: 'Internet Archive', or: 'Internet Archive', several: false }
}
