import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // In sviluppo le API sono sul server Node (cartella server/).
    proxy: { '/api': 'http://localhost:8787' },
  },
})
