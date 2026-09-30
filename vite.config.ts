import { defineConfig } from 'vite';

export default defineConfig({
  root: 'apps/ui',
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4317', '/health': 'http://127.0.0.1:4317' }
  },
  build: { outDir: '../../dist/ui', emptyOutDir: true }
});
