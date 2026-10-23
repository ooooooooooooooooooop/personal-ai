import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname, 'src'),
  publicDir: resolve(__dirname, 'public'),
  server: {
    port: 5173,
    proxy: {
      '/cmd': 'http://127.0.0.1:4173',
      '/events': 'http://127.0.0.1:4173',
      '/api': 'http://127.0.0.1:4173',
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
