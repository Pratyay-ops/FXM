/**
 * `@fxm/platform`: gives every provider the right `fetch` for the platform FXM runs on, tells
 * the app which tier it is in, and makes every YouTube call draw from one request budget.
 * See the package README.
 *
 * @module
 */

export * from './budget'
export * from './capabilities'
export * from './capacitor'
export * from './clock'
export * from './connect'
export * from './cors'
export * from './hosts'
export * from './innertube'
export * from './lite'
export * from './native'
export * from './node'
export * from './platform'
export * from './storage'
export * from './tauri'
export * from './transport'
export * from './web'
