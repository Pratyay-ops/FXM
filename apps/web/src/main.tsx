import './styles/index.css'
import { registerSW } from 'virtual:pwa-register'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app'
import { createAppRouter } from './app/router'
import { registerServiceWorker } from './features/pwa/service-worker'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing the #root element')

registerServiceWorker(registerSW)

createRoot(root).render(
  <StrictMode>
    <App router={createAppRouter()} />
  </StrictMode>,
)
