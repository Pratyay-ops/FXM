/**
 * `@fxm/platform`: gives every provider the right `fetch` for the platform FXM runs on, tells
 * the app which tier it is in, and makes every YouTube call draw from one request budget.
 *
 * @module
 */

export * from './budget'
export * from './clock'
export * from './connect'
export * from './cors'
export * from './hosts'
export * from './innertube'
export * from './storage'
