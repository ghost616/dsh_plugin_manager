import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  // The harness imports the real component from the repository source tree and
  // React from the repository's node_modules: both live above this root.
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
  },
  resolve: { dedupe: ['react', 'react-dom'] },
})
