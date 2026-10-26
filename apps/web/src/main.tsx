import './styles/index.css'
import { registerSW } from 'virtual:pwa-register'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app'
import { createAppRouter } from './app/router'
import { markConnecting } from './app/services/connecting'
import { connectDesktopNotices, setUpDesktopPlayback } from './app/services/desktop'
import { wireEqualizerActions } from './features/audio-effects/equalizer-actions'
import { startConnect } from './features/connect/start'
import { connectAppPolicy, createPendingPolicy } from './features/now-playing/playback-policy'
import { listenForInstallPrompt } from './features/pwa/install'
import { registerServiceWorker } from './features/pwa/service-worker'
import { startScrobbling } from './features/scrobble/start-scrobbling'
import { appSources } from './features/search/sources-context'
import { canonicalAppPath } from './lib/canonical-path'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing the #root element')
const container: HTMLElement = root

async function start(): Promise<void> {
  // Before the first render: the browser may offer to install FXM as soon as the page loads.
  listenForInstallPrompt()
  registerServiceWorker(registerSW)

  // Detect FXM Connect and the Lite tier while the first page renders.
  startConnect()
  // Opt-in: it loads, opens and sends nothing until the user connects an account.
  startScrobbling()
  // "Equalizer" in the track menus opens the Sound dialog (stage 8.1).
  wireEqualizerActions()

  // FXM Connect's marker is on the page but it hasn't answered yet: until it does, the pages say
  // they are connecting rather than offering to install it (see app/services/connecting.ts).
  const stopConnecting = markConnecting(appSources)

  // The desktop app's player plays through its own engine and options (stage 7.3), so they are
  // in place before the first render creates the player. In a browser this does nothing.
  const desktop = await setUpDesktopPlayback().catch((error: unknown) => {
    console.error('FXM: could not set up the desktop playback', error)
    return undefined
  })
  // Settings → About shows the third-party notices that desktop releases carry (stage 7.5).
  connectDesktopNotices()

  createRoot(container).render(
    <StrictMode>
      <App router={createAppRouter()} />
    </StrictMode>,
  )

  // The real platform, providers and player (src/app/services) load beside the first render,
  // in chunks of their own, so the shell paints at once: the pages follow the sources registry
  // as the platform detects the tier and the providers register, and the play buttons come with
  // the player. They also run the download queue (stage 4.1), once the tier is known, so that
  // downloads queued in an earlier visit continue where FXM can download them. startAppServices
  // never rejects.
  import('./app/services')
    .then(({ startAppServices }) => startAppServices({ desktop }))
    .catch((error: unknown) => {
      console.error('FXM: could not load the music services', error)
      stopConnecting()
      // Nothing will connect the player's policy: plays stop with a reason rather than wait,
      // and imports say they can't run.
      connectAppPolicy(createPendingPolicy())
      void import('./features/import/services').then(({ connectAppImportServices }) =>
        connectAppImportServices(() => Promise.reject(error)),
      )
    })
}

// An address with an encoded base, such as /%61pp/, gets none of the /app/* header rule's
// headers on Cloudflare Pages: go to its plain spelling before anything starts.
const canonical = canonicalAppPath(location.pathname, import.meta.env.BASE_URL)
if (canonical === undefined) void start()
else location.replace(`${canonical}${location.search}${location.hash}`)
