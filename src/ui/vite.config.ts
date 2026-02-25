import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const buildId = process.env.SOURCE_VERSION
  || process.env.GIT_SHA
  || process.env.HEROKU_SLUG_COMMIT
  || String(Date.now())

const apiPort = process.env.VITE_API_PORT || '3700'

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
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        demo: resolve(__dirname, 'demo.html'),
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true }
    }
  }
})
