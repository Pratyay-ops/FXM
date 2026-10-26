import './styles/index.css'
import { registerSW } from 'virtual:pwa-register'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app'
import { createAppRouter } from './app/router'
import { markConnecting } from './app/services/connecting'
import { startConnect } from './features/connect/start'
import { connectAppPolicy, createPendingPolicy } from './features/now-playing/playback-policy'
import { listenForInstallPrompt } from './features/pwa/install'
import { registerServiceWorker } from './features/pwa/service-worker'
import { startScrobbling } from './features/scrobble/start-scrobbling'
import { appSources } from './features/search/sources-context'
import { startSpotifyAccount } from './features/spotify-account/start'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing the #root element')

// Before the first render: the browser may offer to install FXM as soon as the page loads.
listenForInstallPrompt()
registerServiceWorker(registerSW)

// Detect FXM Connect and the Lite tier while the first page renders.
startConnect()
// Opt-in: it loads, opens and sends nothing until the user connects an account.
startScrobbling()
// Opt-in too: nothing loads or contacts Spotify until the user connects their account.
startSpotifyAccount()

// FXM Connect's marker is on the page but it hasn't answered yet: until it does, the pages say
// they are connecting rather than offering to install it (see app/services/connecting.ts).
const stopConnecting = markConnecting(appSources)

createRoot(root).render(
  <StrictMode>
    <App router={createAppRouter()} />
  </StrictMode>,
)

// The real platform, providers and player (src/app/services) load beside the first render, in
// chunks of their own, so the shell paints at once: the pages follow the sources registry as the
// platform detects the tier and the providers register, and the play buttons come with the
// player. startAppServices never rejects.
import('./app/services')
  .then(({ startAppServices }) => startAppServices())
  .catch((error: unknown) => {
    console.error('FXM: could not load the music services', error)
    stopConnecting()
    // Nothing will connect the player's policy: plays stop with a reason rather than wait.
    connectAppPolicy(createPendingPolicy())
  })

// Queued downloads continue in whichever tab gets to run the queue (stage 4.1). Loaded after
// the first render, so the database and the download manager stay out of the entry chunk.
void import('./features/downloads/runtime').then(({ startDownloads }) => startDownloads())
