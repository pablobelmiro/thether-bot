import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const webDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(webDir, '..')

export default defineConfig({
  root: webDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(webDir, 'src'),
      '@shared': path.join(projectDir, 'src/shared'),
    },
  },
  css: {
    // postcss.config.js lives next to this file; it resolves tailwind.config.js absolutely.
    postcss: webDir,
  },
  build: {
    outDir: path.join(projectDir, 'dist/web'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          markdown: ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [projectDir] },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4100',
        changeOrigin: false,
        ws: true,
      },
    },
  },
})
