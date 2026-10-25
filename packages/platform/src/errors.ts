/**
 * The errors a transport throws when it refuses a request without sending it. Each is an
 * `FxmError` with code `Unsupported`, so code that only knows `@fxm/core`'s codes keeps working,
 * and carries a `reason`, so the app can tell the cases apart without parsing messages:
 *
 * - a route this platform cannot reach right now, which FXM Connect, the Lite tier or the app
 *   would open ({@link RouteUnavailableError}): the onboarding UI offers the fix
 * - a host FXM does not contact, a request a route cannot carry, or a redirect that left the
 *   host table: bugs or misbehaving servers, never a tier gap
 *
 * The request budget's refusals are `BudgetError`s (`budget.ts`) and FXM Connect's are
 * `ConnectBridgeError`s (`connect.ts`).
 *
 * @module
 */

import { FxmError, isFxmError } from '@fxm/core'
import type { ConnectFeature } from './connect'
import type { RouteKind } from './transport'

/** Every {@link TransportErrorReason}. */
export const TRANSPORT_ERROR_REASONS = [
  'unknown-host',
  'route-closed',
  'bad-request',
  'redirect',
] as const

/**
 * Why a transport refused a request:
 *
 * - `unknown-host`: the host is not in the host table and the user did not add it
 * - `route-closed`: the platform cannot reach this kind of request right now (see
 *   {@link RouteUnavailableError})
 * - `bad-request`: a request its route cannot carry, such as an InnerTube call whose body is not
 *   JSON, a `POST` to a host the user added, or a URL that is not absolute
 * - `redirect`: a redirect to a host outside the table or of another class, more redirects than
 *   allowed, or one the request asked not to follow
 */
export type TransportErrorReason = (typeof TRANSPORT_ERROR_REASONS)[number]

/** A request a transport refused without sending it (`Unsupported`), and why. */
export class TransportError extends FxmError {
  /** Why the request was refused. */
  readonly reason: TransportErrorReason

  /**
   * @param reason Why the request was refused.
   * @param message Human-readable details, for logs. Never includes a query string.
   * @param options The underlying cause, if any.
   */
  constructor(reason: TransportErrorReason, message: string, options: { cause?: unknown } = {}) {
    super('Unsupported', message, 'cause' in options ? { cause: options.cause } : {})
    this.reason = reason
  }
}

/** Every {@link RouteNeed}. */
export const ROUTE_NEEDS = ['connect', 'lite', 'native', 'sandbox'] as const

/**
 * Something that would open a closed route:
 *
 * - `connect`: FXM Connect in this browser, current and with the route's feature
 * - `lite`: the Lite tier (its self-test passed and its kill switch is off)
 * - `native`: native networking: the desktop or Android app on the web, or, inside one of those
 *   apps, a build whose native HTTP exists (stages 7.2 and 6.2)
 * - `sandbox`: the web app's sandbox documents (stage 1.10), which a build without them lacks
 */
export type RouteNeed = (typeof ROUTE_NEEDS)[number]

/** A route the platform cannot reach right now, and what would open it. */
export class RouteUnavailableError extends TransportError {
  /** The closed route. */
  readonly route: RouteKind
  /** What would open it: any one of these. */
  readonly needs: readonly RouteNeed[]
  /** The FXM Connect feature the route takes, for an "update FXM Connect" hint. */
  readonly connectFeature: ConnectFeature | undefined

  /**
   * @param route The closed route.
   * @param needs What would open it: any one of these.
   * @param message Human-readable details, for logs.
   * @param connectFeature The FXM Connect feature the route takes, if FXM Connect can open it.
   */
  constructor(
    route: RouteKind,
    needs: readonly RouteNeed[],
    message: string,
    connectFeature?: ConnectFeature,
  ) {
    super('route-closed', message)
    this.route = route
    this.needs = [...needs]
    this.connectFeature = connectFeature
  }
}

/**
 * Whether `value` is a {@link TransportError}, optionally with a given `reason`. Like
 * `isFxmError`, it also recognizes errors from a second copy of this module.
 */
export function isTransportError(
  value: unknown,
  reason?: TransportErrorReason,
): value is TransportError {
  if (!isFxmError(value, 'Unsupported')) return false
  const found = (value as { reason?: unknown }).reason
  return (
    typeof found === 'string' &&
    (TRANSPORT_ERROR_REASONS as readonly string[]).includes(found) &&
    (reason === undefined || found === reason)
  )
}

/** Whether `value` is a {@link RouteUnavailableError}, also from a second copy of this module. */
export function isRouteUnavailable(value: unknown): value is RouteUnavailableError {
  return (
    isTransportError(value, 'route-closed') &&
    Array.isArray((value as { needs?: unknown }).needs) &&
    typeof (value as { route?: unknown }).route === 'string'
  )
}
