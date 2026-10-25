/**
 * The browser tests' fixtures: the test network (one per worker), and the harness page at the
 * FXM origin with typed calls into `window.fxmHarness`.
 *
 * @module
 */

import { test as base, type Page } from '@playwright/test'
import type { Outcome, PlayOptions, RungResult, StartOptions } from './harness/harness.ts'
import { FXM, startTestNetwork, type TestNetwork } from './network.ts'
import { E2E_PORT } from './port.ts'

export { expect } from '@playwright/test'

/** A request's init, as the harness passes it to `fetch`. */
export interface FetchInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
}

/** Typed calls into the harness page. */
export class Harness {
  constructor(readonly page: Page) {}

  start(options: StartOptions = {}) {
    return this.page.evaluate((args) => window.fxmHarness.start(args), options)
  }

  setKilled(killed: boolean) {
    return this.page.evaluate((value) => window.fxmHarness.setKilled(value), killed)
  }

  refresh() {
    return this.page.evaluate(() => window.fxmHarness.refresh())
  }

  retest() {
    return this.page.evaluate(() => window.fxmHarness.retest())
  }

  liteReady() {
    return this.page.evaluate(() => window.fxmHarness.liteReady())
  }

  budget() {
    return this.page.evaluate(() => window.fxmHarness.budget())
  }

  frames() {
    return this.page.evaluate(() => window.fxmHarness.frames())
  }

  fetch(url: string, init: FetchInit = {}): Promise<Outcome> {
    return this.page.evaluate(([target, options]) => window.fxmHarness.fetch(target, options), [
      url,
      init,
    ] as const)
  }

  innerTube(url: string, init: FetchInit & { method: string }): Promise<Outcome> {
    return this.page.evaluate(([target, options]) => window.fxmHarness.innerTube(target, options), [
      url,
      init,
    ] as const)
  }

  pageFetch(url: string, init: FetchInit = {}): Promise<Outcome> {
    return this.page.evaluate(([target, options]) => window.fxmHarness.pageFetch(target, options), [
      url,
      init,
    ] as const)
  }

  raw(path: string, messages: Record<string, unknown>[], waitMs?: number) {
    return this.page.evaluate(([target, list, wait]) => window.fxmHarness.raw(target, list, wait), [
      path,
      messages,
      waitMs,
    ] as const)
  }

  resolveAndPlay(options: PlayOptions): Promise<RungResult[]> {
    return this.page.evaluate((args) => window.fxmHarness.resolveAndPlay(args), options)
  }
}

export const test = base.extend<{ harness: Harness }, { network: TestNetwork }>({
  network: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a fixture uses from its first parameter.
    async ({}, use) => {
      const network = await startTestNetwork({ port: E2E_PORT })
      await use(network)
      await network.close()
    },
    { scope: 'worker', auto: true },
  ],
  harness: async ({ page, network }, use) => {
    network.reset()
    await page.goto(`${FXM}/harness.html`)
    await use(new Harness(page))
  },
})
