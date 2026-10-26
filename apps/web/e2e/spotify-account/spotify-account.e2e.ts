/**
 * The Spotify account end to end (stage 3.5): the production build of FXM as `make dist`
 * composes it, on its real origin and under its production headers, with the development build
 * of FXM Connect loaded into Chromium (new headless mode, a throwaway profile), against a
 * made-up Spotify (network.ts). Nothing reaches the internet and no real account is used.
 *
 * It checks what the owner's manual test checks with a real account (the feature's README):
 * the notice before anything happens, FXM Connect's login switch, the bridge's token request
 * with the browser's Spotify session (with third-party cookies allowed and blocked), the copies
 * in the library, a later sync, Disconnect, and that the token stays out of storage, URLs and
 * the console. Firefox can't load an extension under Playwright: it is the manual test's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type BrowserContext,
  chromium,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test'
import {
  ACCOUNT_TOKEN_PREFIX,
  FXM,
  HOSTS,
  type Network,
  nativeId,
  PATHFINDER_HOST,
  PORT,
  SESSION,
  SPOTIFY_HOST,
  startNetwork,
} from './network'

const WEB_DIR = fileURLToPath(new URL('../../', import.meta.url))
/** FXM Connect's development build (`FXM_EXTENSION_DEV=1 make extension`). */
const EXTENSION_DIR =
  process.env.FXM_CONNECT_DIR ?? join(WEB_DIR, '..', 'extension', 'dist', 'dev', 'chromium')

/** Every pathfinder operation the sync may send: reads only, never a write. */
const READ_ONLY_OPERATIONS = new Set([
  'profileAttributes',
  'fetchLibraryTracks',
  'libraryV3',
  'fetchPlaylist',
  'home',
])

let network: Network

test.beforeEach(async () => {
  network = await startNetwork()
})

test.afterEach(async () => {
  await network.close()
})

interface Browser {
  context: BrowserContext
  profile: string
}

/**
 * Chromium with FXM Connect in a throwaway profile, signed in to the made-up Spotify: its
 * session cookie on `.spotify.com`, as Spotify sets `sp_dc`, with `sameSite`. A second cookie,
 * `SameSite=None`, tells whether the browser sends third-party cookies at all. With
 * `blockThirdPartyCookies`, the profile starts with Chrome's "Block third-party cookies".
 */
async function launch(options: {
  blockThirdPartyCookies: boolean
  sameSite: 'Lax' | 'None'
}): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), 'fxm-spotify-profile-'))
  if (options.blockThirdPartyCookies) {
    mkdirSync(join(profile, 'Default'))
    writeFileSync(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }),
    )
  }
  const rules = [...HOSTS.map((host) => `MAP ${host} 127.0.0.1:${PORT}`), 'MAP * ~NOTFOUND'].join(
    ', ',
  )
  const context = await chromium.launchPersistentContext(profile, {
    // The full Chromium build in the new headless mode: the headless shell has no extensions.
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    args: [
      `--host-resolver-rules=${rules}`,
      '--ignore-certificate-errors',
      '--disable-quic',
      '--mute-audio',
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  })
  await context.addCookies([
    {
      ...SESSION,
      domain: '.spotify.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: options.sameSite,
    },
    {
      name: 'e2e_probe',
      value: 'third-party',
      domain: 'open.spotify.com',
      path: '/',
      secure: true,
      sameSite: 'None',
    },
  ])
  return { context, profile }
}

async function close({ context, profile }: Browser) {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}

async function extensionId(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  return new URL(worker.url()).host
}

/** The user turns on "Use my Spotify login from this browser" in FXM Connect's options. */
async function turnOnLogin(context: BrowserContext) {
  const options = await context.newPage()
  await options.goto(`chrome-extension://${await extensionId(context)}/options.html`)
  const toggle = options.getByLabel('Use my Spotify login from this browser')
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(options.getByRole('status')).toHaveText(/^Saved\./)
  await options.close()
}

function accountSection(page: Page): Locator {
  return page.locator('section', {
    has: page.getByRole('heading', { name: 'Spotify account', level: 2 }),
  })
}

/** Whether the browser sent the third-party probe cookie to Spotify from FXM's page. */
async function sendsThirdPartyCookies(page: Page): Promise<boolean> {
  network.clearLog()
  // A credentialed request from the page, as a third-party resource would be; the app's policy
  // allows open.spotify.com in connect-src, and none of FXM Connect's rules covers this path.
  await page.evaluate(async () => {
    await fetch('https://open.spotify.com/e2e-cookie-probe.gif', {
      mode: 'no-cors',
      credentials: 'include',
    }).catch(() => undefined)
  })
  const probe = network.requests(SPOTIFY_HOST, '/e2e-cookie-probe.gif')
  expect(probe).toHaveLength(1)
  return probe[0]?.cookie?.includes('e2e_probe=third-party') === true
}

/** Everything the page can store, and its URL, as one string. */
function storageDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts = [
      location.href,
      document.cookie,
      JSON.stringify({ ...localStorage }),
      JSON.stringify({ ...sessionStorage }),
    ]
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        parts.push(JSON.stringify(rows))
      }
      db.close()
    }
    return parts.join('\n')
  })
}

/**
 * Waits until the section says the account is connected. On a busy machine FXM Connect's bridge
 * can answer later than the check waits; the section then says it couldn't check, and the test
 * does what a user would: Try again, at most twice. It logs each retry.
 */
async function expectConnected(page: Page, section: Locator) {
  const deadline = Date.now() + 90_000
  let retries = 0
  while (Date.now() < deadline) {
    const text = (await section.textContent()) ?? ''
    if (text.includes('Connected as')) break
    if (text.includes('couldn’t check your Spotify login') && retries < 2) {
      retries += 1
      console.log(`The login check failed (${text.slice(0, 160)}); trying again (${retries})`)
      await section.getByRole('button', { name: 'Try again' }).click()
    }
    await page.waitForTimeout(500)
  }
  await expect(section).toContainText('Connected as E2E Listener.')
}

/** Connects the account from Settings: the notice, then FXM Connect's switch, then Try again. */
async function connect(page: Page, browser: Browser) {
  await page.goto(`${FXM}/app/settings`)
  const section = accountSection(page)
  await section.getByRole('button', { name: 'Connect your account' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Connect your Spotify account?' })
  await expect(dialog).toContainText(
    'Spotify’s User Guidelines forbid accessing Spotify by automated means',
  )
  // Nothing happened before the notice was accepted.
  expect(network.requests(SPOTIFY_HOST, '/api/token')).toEqual([])
  await dialog.getByRole('button', { name: 'Connect' }).click()
  // FXM Connect's login is off by default: Settings says how to turn it on.
  await expect(section).toContainText('FXM Connect doesn’t use your Spotify login yet')
  expect(network.requests(SPOTIFY_HOST, '/api/token?reason=transport')).toEqual([])
  await turnOnLogin(browser.context)
  await page.bringToFront()
  await section.getByRole('button', { name: 'Try again' }).click()
  return section
}

test('connects through FXM Connect, syncs read-only, and disconnects', async () => {
  const browser = await launch({ blockThirdPartyCookies: false, sameSite: 'Lax' })
  const consoleLines: string[] = []
  try {
    const page = await browser.context.newPage()
    page.on('console', (message) => consoleLines.push(message.text()))
    await page.goto(`${FXM}/app/settings`)
    // Third-party cookies are allowed in this run.
    expect(await sendsThirdPartyCookies(page)).toBe(true)
    // With FXM Connect, the app reads Spotify in this browser: its one provider serves search
    // and the account alike.
    await expect(page.getByText('Search and browse Spotify too.', { exact: false })).toBeVisible()

    const clicked = Date.now()
    const section = await connect(page, browser)
    try {
      await expectConnected(page, section)
    } finally {
      if (process.env.FXM_E2E_DEBUG) {
        const timeline = network.log
          .filter((entry) => entry.host !== 'fxmusic.pages.dev' || entry.path.includes('sandbox'))
          .map((entry) => `${entry.at - clicked} ms ${entry.method} ${entry.host}${entry.path}`)
        console.log(timeline.join('\n'))
      }
    }
    await expect(section).toContainText(
      'Last synced just now: Liked songs on Spotify (3 songs) and 2 playlists.',
    )

    // The account token came through FXM Connect's bridge, with the browser's session…
    const tokens = network.requests(SPOTIFY_HOST, '/api/token?reason=transport')
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.every((request) => request.cookie?.includes(`${SESSION.name}=`))).toBe(true)
    // …and nothing else the page sent to Spotify carried a cookie.
    const others = network.log.filter(
      (entry) =>
        (entry.host === SPOTIFY_HOST || entry.host === PATHFINDER_HOST) &&
        !entry.path.startsWith('/api/token?reason=transport') &&
        !entry.path.startsWith('/e2e-cookie-probe'),
    )
    expect(others.filter((entry) => entry.cookie !== undefined)).toEqual([])
    // Read-only: the sync only ever read, with the account's token.
    const operations = network.requests(PATHFINDER_HOST).filter((entry) => entry.method === 'POST')
    expect(operations.every((entry) => READ_ONLY_OPERATIONS.has(entry.operation ?? ''))).toBe(true)
    for (const operation of ['profileAttributes', 'fetchLibraryTracks', 'libraryV3', 'home']) {
      const sent = operations.filter((entry) => entry.operation === operation)
      expect(sent.length).toBeGreaterThan(0)
      expect(sent.every((entry) => entry.authorization?.includes(ACCOUNT_TOKEN_PREFIX))).toBe(true)
    }

    // The copies are in the library, the private playlist's too.
    await page.goto(`${FXM}/app/library?tab=playlists`)
    const playlists = page.getByRole('list', { name: 'Your playlists' })
    await expect(playlists.getByRole('link', { name: 'Liked songs on Spotify' })).toBeVisible()
    await expect(playlists.getByRole('link', { name: 'Late night (private)' })).toBeVisible()
    await playlists.getByRole('link', { name: 'Road trip' }).click()
    await expect(page.getByRole('heading', { name: 'Road trip', level: 1 })).toBeVisible()
    for (const n of [11, 12, 13])
      await expect(page.getByText(`E2E song ${n}`).first()).toBeVisible()

    // Spotify changes; Sync now brings the changes in.
    network.account.liked.unshift(4)
    const roadTrip = network.account.playlists[0]
    if (roadTrip) {
      roadTrip.tracks.push(14)
      roadTrip.revision += 1
    }
    await page.goto(`${FXM}/app/settings`)
    await section.getByRole('button', { name: 'Sync now' }).click()
    await expect(section).toContainText('Liked songs on Spotify (4 songs) and 2 playlists.')
    await page.goto(`${FXM}/app/playlist/local:playlist:spotify-${nativeId('p', 1)}`)
    await expect(page.getByText('E2E song 14').first()).toBeVisible()

    // The token never reaches storage, a URL or the console.
    expect(network.accountTokens.length).toBeGreaterThan(0)
    expect(await storageDump(page)).not.toContain(ACCOUNT_TOKEN_PREFIX)
    expect(consoleLines.join('\n')).not.toContain(ACCOUNT_TOKEN_PREFIX)

    // Disconnect: the token is forgotten at once, the copies stay.
    await page.goto(`${FXM}/app/settings`)
    await section.getByRole('button', { name: 'Disconnect' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Disconnect your Spotify account?' })
    await expect(dialog).toContainText('Your library keeps the 3 playlists it synced')
    await dialog.getByRole('button', { name: 'Disconnect' }).click()
    await expect(section).toContainText('Disconnected. Your library keeps what FXM synced.')
    await expect(section.getByRole('button', { name: 'Connect your account' })).toBeVisible()
    network.clearLog()
    await page.reload()
    await expect(section.getByRole('button', { name: 'Connect your account' })).toBeVisible()
    await page.goto(`${FXM}/app/library?tab=playlists`)
    await expect(
      page.getByRole('list', { name: 'Your playlists' }).getByRole('link', { name: 'Road trip' }),
    ).toBeVisible()
    // Nothing asks for the account any more.
    expect(network.requests(SPOTIFY_HOST, '/api/token?reason=transport')).toEqual([])
    expect(network.requests(PATHFINDER_HOST)).toEqual([])
    expect(await storageDump(page)).not.toContain(ACCOUNT_TOKEN_PREFIX)
  } finally {
    await close(browser)
  }
})

for (const sameSite of ['None', 'Lax'] as const) {
  test(`gets the login through FXM Connect with third-party cookies blocked (SameSite=${sameSite})`, async () => {
    const browser = await launch({ blockThirdPartyCookies: true, sameSite })
    try {
      const page = await browser.context.newPage()
      await page.goto(`${FXM}/app/settings`)
      // The setting works: FXM's page sends no third-party cookie to Spotify.
      expect(await sendsThirdPartyCookies(page)).toBe(false)
      const section = await connect(page, browser)
      // FXM Connect's own request still carries the session: Chromium doesn't count an
      // extension's request to a host it may access as a third-party one.
      await expectConnected(page, section)
      await expect(section).toContainText('Liked songs on Spotify (3 songs) and 2 playlists.')
      const tokens = network.requests(SPOTIFY_HOST, '/api/token?reason=transport')
      expect(tokens.every((request) => request.cookie?.includes(`${SESSION.name}=`))).toBe(true)
    } finally {
      await close(browser)
    }
  })
}

test('says so when the browser has no Spotify login', async () => {
  const browser = await launch({ blockThirdPartyCookies: false, sameSite: 'Lax' })
  try {
    await browser.context.clearCookies({ name: SESSION.name })
    const page = await browser.context.newPage()
    const section = await connect(page, browser)
    await expect(section).toContainText('FXM Connect got no Spotify login from this browser')
    await expect(section.getByRole('link', { name: /open\.spotify\.com/ })).toBeVisible()
    expect(network.requests(PATHFINDER_HOST).filter((entry) => entry.method === 'POST')).toEqual([])
    // The user signs in at open.spotify.com, comes back and tries again.
    await browser.context.addCookies([
      {
        ...SESSION,
        domain: '.spotify.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
    await section.getByRole('button', { name: 'Try again' }).click()
    await expectConnected(page, section)
  } finally {
    await close(browser)
  }
})
