import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app'
import { createAppRouter } from './app/router'
import { startConnect } from './features/connect/start'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing the #root element')

// Detect FXM Connect and the Lite tier while the first page renders.
startConnect()

createRoot(root).render(
  <StrictMode>
    <App router={createAppRouter()} />
  </StrictMode>,
)

// Queued downloads continue in whichever tab gets to run the queue (stage 4.1). Loaded after
// the first render, so the database and the download manager stay out of the entry chunk.
void import('./features/downloads/runtime').then(({ startDownloads }) => startDownloads())
