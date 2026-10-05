import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Renderer bundle served only from app://bundle by the main process (no dev server, no CDN).
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: '/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
