import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const clientRoot = fileURLToPath(new URL('./src/client', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/client', import.meta.url));

export default defineConfig({
  root: clientRoot,
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    cssMinify: true
  },
  server: {
    host: '127.0.0.1',
    strictPort: true
  }
});
