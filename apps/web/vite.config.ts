import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Production serves the player from /app/ (the landing page owns /). The router
  // reads its basename from import.meta.env.BASE_URL, so this is the only place to change.
  base: '/app/',
  plugins: [react(), tailwindcss()],
})
