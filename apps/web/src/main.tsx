import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app'
import { createAppRouter } from './app/router'
import { startAppServices } from './app/services'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing the #root element')

function render(container: HTMLElement) {
  createRoot(container).render(
    <StrictMode>
      <App router={createAppRouter()} />
    </StrictMode>,
  )
}

// The real platform, providers and player first (src/app/services): FXM Connect answers within
// milliseconds, so the first render already shows the right tier and its sources, instead of
// the Free tier for a moment. startAppServices never rejects.
void startAppServices().then(() => render(root))
