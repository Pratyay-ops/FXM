import type { ChunkGroup } from './chunks'

// The web app's performance budgets: what make dist's build may weigh, and how fast its first
// load must be on a mid-range phone over a slow network. apps/web/e2e/README.md has the baseline
// they were set from, and how to change them: sizes from any build, timings from CI's runner.

/**
 * The lazy features whose chunks have a budget, each named after its budget (see `chunkGraph` in
 * chunks.ts). A root the first load holds fails the run, unless it is in the group's
 * `inFirstLoad`; one listed there fails it once it loads lazily, so the list only shrinks.
 */
export const GROUPS: readonly ChunkGroup<Budget>[] = [
  {
    // The provider (stage 1.3), the stream resolver's module host (1.13), and youtubei.js, which
    // the provider loads on first use.
    name: 'youtube',
    roots: [
      'packages/sources/src/youtube/index.ts',
      'packages/sources/src/youtube/module/index.ts',
    ],
    dynamic: true,
  },
  // Home's shelves and onboarding (stage 3.3), which the Home page loads after the shell.
  { name: 'home', roots: ['apps/web/src/features/home/home-content.tsx'] },
  {
    // The download queue and its database (stage 4.1), and the worker that writes the files.
    name: 'downloads',
    roots: [
      'apps/web/src/features/downloads/runtime.ts',
      'apps/web/src/features/downloads/actions.ts',
      'apps/web/src/features/downloads/opfs/worker.ts',
    ],
    // The shell's download buttons and menus import these two statically today (hooks.ts and
    // menu.ts in features/downloads, and the library's track lists), so their chunks are in the
    // first load, though the app's services load them with import(). The worker stays lazy.
    inFirstLoad: [
      'apps/web/src/features/downloads/runtime.ts',
      'apps/web/src/features/downloads/actions.ts',
    ],
  },
]

/**
 * The device and network the timings are measured on: Lighthouse's mobile defaults, a mid-range
 * phone (Moto G Power, 2022) on "Slow 4G", applied the way Chrome DevTools throttles: 150 ms of
 * round trip and 1.6 Mbit/s down, which DevTools turns into 562.5 ms of latency per request and
 * 1,474.56 kbit/s down, 675 kbit/s up, and a CPU four times slower than the machine's.
 */
export const PHONE = {
  name: 'a mid-range phone (Moto G Power) on Slow 4G: 412×823 px at 1.75×, CPU 4× slower, 562.5 ms latency, 1.47 Mbit/s down, 675 kbit/s up',
  context: {
    viewport: { width: 412, height: 823 },
    deviceScaleFactor: 1.75,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  },
  cpuSlowdown: 4,
  network: {
    latencyMs: 562.5,
    downloadBytesPerSecond: (1474.56 * 1024) / 8,
    uploadBytesPerSecond: (675 * 1024) / 8,
  },
} as const

/** How many first loads the timings take the median of. */
export const RUNS = 7

/**
 * The budgets. Sizes are bytes as Chromium downloads them from Cloudflare Pages (brotli, see
 * `brotli` in chunks.ts); timings are medians of {@link RUNS} first loads on {@link PHONE}.
 */
export const BUDGETS = {
  /** The entry chunk, the script `index.html` starts. */
  entry: 150_000,
  /** What `index.html` loads before the app runs: the entry chunk, its imports, its styles. */
  initial: 335_000,
  /** What each lazy feature adds to the first load (see {@link GROUPS}). */
  youtube: 220_000,
  home: 27_500,
  downloads: 14_500,
  /** A first visit of `/app/` until the network is idle, without the service worker. */
  firstLoad: 455_000,
  /** The same visit with the service worker, which stores the app shell for offline use. */
  firstVisit: 1_650_000,
  /** Largest Contentful Paint of that first visit, in milliseconds. */
  lcp: 6_500,
  /** Cumulative Layout Shift of the visit and the interactions after it. */
  cls: 0.02,
  /**
   * Interaction to Next Paint of a few taps and some typing after it, in milliseconds: the line
   * web-vitals calls good, as CI's runners differ by half (80 and 120 ms on two of them).
   */
  inp: 200,
} as const

/** A budget's name. */
export type Budget = keyof typeof BUDGETS
