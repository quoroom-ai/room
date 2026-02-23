import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const buildId = process.env.SOURCE_VERSION
  || process.env.GIT_SHA
  || process.env.HEROKU_SLUG_COMMIT
  || String(Date.now())

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react(), tailwindcss()],
  define: {
    __APP_BUILD_ID__: JSON.stringify(buildId),
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared'),
      '@ui': resolve(__dirname)
    }
  },
  build: {
    outDir: resolve(__dirname, '../../out/ui'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 700
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3700',
      '/ws': { target: 'ws://127.0.0.1:3700', ws: true }
    }
  }
})
