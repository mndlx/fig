import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Il tsconfig del frontend non include i tipi di Node: basta dichiarare le variabili d'ambiente.
declare const process: { env: Record<string, string | undefined> }

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // 5174 è la porta registrata su Keycloak per lo sviluppo (http://localhost:5174/auth/callback).
    port: 5174,
    strictPort: true,
    // API e login sono sul server Node (cartella server/, porta 8787).
    // FIG_API permette di puntare a un altro server (es. un'istanza di prova senza login).
    proxy: {
      '/api': process.env.FIG_API ?? 'http://localhost:8787',
      '/auth': process.env.FIG_API ?? 'http://localhost:8787',
    },
  },
})
