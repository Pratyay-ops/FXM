/**
 * Compile-time assertions for the type tests in this folder. `tsc` checks them; nothing runs.
 *
 * @module
 */

/** Compiles only when `T` is `true`. */
export type Assert<T extends true> = T

/** `true` when `A` and `B` are the same type. */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** `true` when `A` is assignable to `B`. */
export type Extends<A, B> = [A] extends [B] ? true : false
