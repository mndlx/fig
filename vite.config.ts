import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // 5174 è la porta registrata su Keycloak per lo sviluppo (http://localhost:5174/auth/callback).
    port: 5174,
    strictPort: true,
    // API e login sono sul server Node (cartella server/, porta 8787).
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
    },
  },
})
