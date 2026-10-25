import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  build: { outDir: '../../dist/client', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080', '/mock': 'http://localhost:8080' } },
});
