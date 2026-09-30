import { defineConfig } from 'vitest/config'

// Test dell'app: calcoli su importi, CSV, ricorrenze, gomitoli, previsione e calcolatrice.
// happy-dom fornisce localStorage e document; fake-indexeddb il database del browser.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['fake-indexeddb/auto'],
    include: ['src/**/*.test.ts'],
  },
})
