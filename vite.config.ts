import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist', emptyOutDir: true,
    rollupOptions: { input: { index: resolve(__dirname, 'web/index.html'), login: resolve(__dirname, 'web/login.html') } }, // app + sign-in page
  },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:4317' } },
});
