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
