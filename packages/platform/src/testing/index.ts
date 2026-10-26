/**
 * `@fxm/platform/testing`: fakes for tests in this package and in the apps: a fake clock, a fake
 * Lite sandbox, a fake FXM Connect and a fake `FxmHttp` plugin. Never import this from app code.
 *
 * @module
 */

export * from '../updates/testing'
export * from './evaluator'
export * from './fake-clock'
export * from './fake-connect'
export * from './fake-fxm-http'
export * from './fake-sandbox'
