/**
 * Signed updates for the desktop and Android apps (stage 1.13): the YouTube config and resolver
 * module, fetched from FXM's static site, verified against a public key compiled into the
 * build, and loaded only when newer than what the app has. See `README.md` in this folder.
 *
 * @module
 */

export * from './artifact.ts'
export { keyIdOf, sha256Hex } from './digest.ts'
export * from './format.ts'
export * from './keys.ts'
export * from './loader.ts'
export * from './policy.ts'
export * from './sign.ts'
export * from './store.ts'
export * from './updater.ts'
export * from './verify.ts'
