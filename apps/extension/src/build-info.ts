/**
 * Values the build script injects (Vite `define`), so a bundle carries only the FXM origins of
 * its own variant. Only the entry scripts import this module; tests never do.
 */
declare const __FXM_VERSION__: string
declare const __FXM_DEV__: boolean
declare const __FXM_ORIGINS__: readonly string[]

/** Extension version, from package.json. */
export const VERSION: string = __FXM_VERSION__

/** True in the development build (`FXM_EXTENSION_DEV=1`). */
export const DEV_BUILD: boolean = __FXM_DEV__

/** FXM origins of this build variant (config.ts `fxmOrigins`). */
export const ORIGINS: readonly string[] = __FXM_ORIGINS__
