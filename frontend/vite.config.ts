import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'private-offline-source-maps',
      apply: 'build',
      // Emit maps outside dist. No sourceMappingURL, runtime code or map payload.
      writeBundle(options, bundle) {
        if (!options.dir) throw new Error('Source maps require a directory build')
        const root = resolve(import.meta.dirname, 'debug-symbols')
        const chunks: { file: string; sha256: string; map: string; mapSha256: string }[] = []
        const digest = (text: string) => createHash('sha256').update(text).digest('hex')
        for (const item of Object.values(bundle)) {
          if (item.type !== 'chunk') continue
          if (!item.map) throw new Error(`Missing source map: ${item.fileName}`)
          const mapName = item.fileName + '.map'
          const code = readFileSync(resolve(options.dir, item.fileName), 'utf8')
          const map = readFileSync(resolve(options.dir, mapName), 'utf8')
          mkdirSync(dirname(resolve(root, item.fileName)), { recursive: true })
          writeFileSync(resolve(root, item.fileName), code)
          writeFileSync(resolve(root, mapName), map)
          chunks.push({ file: item.fileName, sha256: digest(code), map: mapName, mapSha256: digest(map) })
          unlinkSync(resolve(options.dir, mapName))
        }
        mkdirSync(root, { recursive: true })
        writeFileSync(resolve(root, 'manifest.json'), JSON.stringify({ kind: 'openstudio_frontend_symbols', chunks }, null, 2))
      },
    },
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
    sourcemap: 'hidden',
    outDir: 'dist',
    emptyOutDir: true,
    // NAM Rack is deliberately isolated as an on-demand feature chunk. Its
    // minified 650–700 kB payload is ~175 kB gzip and does not block app boot.
    chunkSizeWarningLimit: 750,
  }
})
