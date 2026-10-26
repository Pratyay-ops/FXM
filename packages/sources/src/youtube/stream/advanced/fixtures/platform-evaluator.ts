/**
 * The isolated evaluator's test helpers of `@fxm/platform` (its `testing/evaluator` entry): the
 * real evaluator runtime in process, and the stand-in for BotGuard. They are imported by path,
 * not by package name, because `@fxm/platform`'s own tests depend on this package: a dependency
 * back would make a workspace cycle, in which pnpm refuses to run the packages' tasks. Tests only.
 *
 * @module
 */

export * from '../../../../../../platform/src/testing/evaluator'
