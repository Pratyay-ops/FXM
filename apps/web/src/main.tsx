import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app'
import { createAppRouter } from './app/router'
import { markConnecting } from './app/services/connecting'
import { appSources } from './features/search/sources-context'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing the #root element')

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
  })
