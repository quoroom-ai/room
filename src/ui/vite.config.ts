import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared'),
      '@ui': resolve(__dirname)
    }
  },
  build: {
    outDir: resolve(__dirname, '../../out/ui'),
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3700',
      '/ws': { target: 'ws://127.0.0.1:3700', ws: true }
    }
  }
})
