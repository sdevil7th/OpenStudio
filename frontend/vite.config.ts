import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'remove-crossorigin-from-production-html',
      apply: 'build',
      transformIndexHtml(html: string) {
        return html.replace(/\s+crossorigin(?=[\s>])/g, '');
      },
    },
  ],
  server: {
    port: 5183,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // NAM Rack is deliberately isolated as an on-demand feature chunk. Its
    // minified 650–700 kB payload is ~175 kB gzip and does not block app boot.
    chunkSizeWarningLimit: 750,
  }
})
