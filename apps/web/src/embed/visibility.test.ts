import { describe, expect, it } from 'vitest'
import { VISIBILITY_RULE, type VisibilityWindow, watchVisibility } from './visibility'

/** A fake IntersectionObserver class, optionally with v2's `trackVisibility`. */
function fakeObserver(v2: boolean) {
  const instances: {
    callback: IntersectionObserverCallback
    init: IntersectionObserverInit & { trackVisibility?: boolean; delay?: number }
    targets: Element[]
    disconnected: boolean
  }[] = []
  class FakeIntersectionObserver {
    readonly trackVisibility: boolean | undefined
    constructor(
      callback: IntersectionObserverCallback,
      init: IntersectionObserverInit & { trackVisibility?: boolean },
    ) {
      instances.push({ callback, init, targets: [], disconnected: false })
      this.trackVisibility = v2 ? init.trackVisibility : undefined
    }
    observe(target: Element) {
      instances.at(-1)?.targets.push(target)
    }
    disconnect() {
      const instance = instances.at(-1)
      if (instance) instance.disconnected = true
    }
  }
  return {
    Observer: FakeIntersectionObserver as unknown as typeof IntersectionObserver,
    instances,
    /** Reports an entry, as the browser would. */
    report(ratio: number, isVisible?: boolean) {
      const instance = instances.at(-1)
      const entry = { intersectionRatio: ratio, ...(isVisible === undefined ? {} : { isVisible }) }
      instance?.callback([entry as unknown as IntersectionObserverEntry], {} as never)
    },
  }
}

function setup(options: { v2: boolean; width?: number; height?: number }) {
  const fake = fakeObserver(options.v2)
  const view: { -readonly [K in keyof VisibilityWindow]: VisibilityWindow[K] } = {
    IntersectionObserver: fake.Observer,
    innerWidth: options.width ?? 600,
    innerHeight: options.height ?? 232,
  }
  const target = document.createElement('html')
  const gate = watchVisibility(target, view)
  return { ...fake, view, target, gate }
}

describe('watchVisibility', () => {
  it('watches the player with the rule and counts it hidden until the first report', () => {
    const { gate, instances, target, report } = setup({ v2: false })
    expect(instances[0]?.targets).toEqual([target])
    expect(instances[0]?.init).toMatchObject({
      threshold: [0, VISIBILITY_RULE.minRatio, 1],
      trackVisibility: true,
      delay: 100,
    })
    expect(gate.visible()).toBe(false)
    report(1)
    expect(gate.visible()).toBe(true)
  })

  it('needs half the player in view, and a frame of at least 200 × 80', () => {
    const { gate, view, report } = setup({ v2: false })
    report(0.49)
    expect(gate.visible()).toBe(false)
    report(0.5)
    expect(gate.visible()).toBe(true)
    view.innerWidth = 1
    view.innerHeight = 1
    expect(gate.visible()).toBe(false)
    view.innerWidth = 200
    view.innerHeight = 79
    expect(gate.visible()).toBe(false)
    view.innerHeight = 80
    expect(gate.visible()).toBe(true)
  })

  it("trusts Chromium's occlusion tracking where it has it", () => {
    const { gate, report } = setup({ v2: true })
    report(1, false) // Covered, transparent or transformed.
    expect(gate.visible()).toBe(false)
    report(1, true)
    expect(gate.visible()).toBe(true)
    // Fully unobstructed still needs half of it in view.
    report(0.2, true)
    expect(gate.visible()).toBe(false)
  })

  it('refuses where the browser has no IntersectionObserver, and stops when disposed', () => {
    const none = watchVisibility(document.createElement('html'), {
      innerWidth: 600,
      innerHeight: 232,
    })
    expect(none.visible()).toBe(false)
    expect(() => none.dispose()).not.toThrow()

    const { gate, instances } = setup({ v2: true })
    gate.dispose()
    expect(instances[0]?.disconnected).toBe(true)
  })
})
