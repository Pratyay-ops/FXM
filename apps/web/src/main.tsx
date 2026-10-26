import './styles/index.css'
import { registerSW } from 'virtual:pwa-register'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app'
import { createAppRouter } from './app/router'
import { listenForInstallPrompt } from './features/pwa/install'
import { registerServiceWorker } from './features/pwa/service-worker'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing the #root element')

// Before the first render: the browser may offer to install FXM as soon as the page loads.
listenForInstallPrompt()
registerServiceWorker(registerSW)

createRoot(root).render(
  <StrictMode>
    <App router={createAppRouter()} />
  </StrictMode>,
)

// Queued downloads continue in whichever tab gets to run the queue (stage 4.1). Loaded after
// the first render, so the database and the download manager stay out of the entry chunk.
void import('./features/downloads/runtime').then(({ startDownloads }) => startDownloads())
