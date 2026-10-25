import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app'
import { createAppRouter } from './app/router'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing the #root element')

createRoot(root).render(
  <StrictMode>
    <App router={createAppRouter()} />
  </StrictMode>,
)
