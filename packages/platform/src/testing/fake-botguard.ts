/**
 * A stand-in for BotGuard in tests: an "interpreter" script with the same outward shape as
 * Google's (it defines a VM global whose `a` function takes a program and hands back the
 * snapshot and minter functions bgutils-js expects), but with trivial, readable behaviour. No
 * Google code is involved.
 *
 * - The snapshot is `snapshot:<program>`, plus `|config:<EVENT_ID>` when `yt.config_` has one.
 * - The minter derives each token from the integrity token and the content binding:
 *   {@link fakeWebPoToken} computes the same value.
 *
 * @module
 */

/** The global name the fake interpreter defines by default. */
export const FAKE_BOTGUARD_GLOBAL = 'fxmFakeBotGuard'

/** Options for {@link fakeBotGuardInterpreter}. */
export interface FakeBotGuardOptions {
  /** The VM's global name. Default {@link FAKE_BOTGUARD_GLOBAL}. */
  globalName?: string
  /** Leave the minter out of the snapshot's output, as BotGuard does when attestation fails. */
  withoutMinter?: boolean
}

/** The fake interpreter's source. */
export function fakeBotGuardInterpreter(options: FakeBotGuardOptions = {}): string {
  const globalName = options.globalName ?? FAKE_BOTGUARD_GLOBAL
  const minter = options.withoutMinter === true ? 'false' : 'true'
  return `globalThis[${JSON.stringify(globalName)}] = {
  a: function (program, setup) {
    var withMinter = ${minter};
    var snapshot = function (callback, args) {
      var signals = args[2];
      if (withMinter && Array.isArray(signals)) {
        signals.push(function (integrityToken) {
          var key = new TextDecoder().decode(integrityToken);
          return Promise.resolve(function (binding) {
            var text = key + '|' + new TextDecoder().decode(binding);
            return Promise.resolve(new TextEncoder().encode(text));
          });
        });
      }
      var config = globalThis.yt && globalThis.yt.config_;
      var event = config && config.EVENT_ID ? '|config:' + config.EVENT_ID : '';
      callback('snapshot:' + program + event);
    };
    setup(snapshot, function () {}, function () {}, function () {});
    return [function () { return Promise.resolve('sync:' + program); }];
  }
};`
}

/** A fake challenge for `Evaluator.botguardSnapshot`. */
export function fakeBotGuardChallenge(options: FakeBotGuardOptions & { program?: string } = {}) {
  return {
    interpreter: fakeBotGuardInterpreter(options),
    program: options.program ?? 'fake-program',
    globalName: options.globalName ?? FAKE_BOTGUARD_GLOBAL,
  }
}

/** Base64 of UTF-8 text, as an integrity token the fake minter accepts. */
export function fakeIntegrityToken(key: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(key)))
}

/** The token the fake minter mints for `binding` with an integrity token of {@link fakeIntegrityToken}`(key)`. */
export function fakeWebPoToken(key: string, binding: string): string {
  const bytes = new TextEncoder().encode(`${key}|${binding}`)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
}
