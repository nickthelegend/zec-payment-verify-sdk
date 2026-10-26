import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@fixtures': resolve(__dirname, '../../fixtures'), '@deployments': resolve(__dirname, '../../deployments') } },
  server: {
    port: 5180, strictPort: true, fs: { allow: [resolve(__dirname, '../..')] },
    // Opt in when the remote API permits the hosted console but not a localhost origin.
    proxy: process.env.VITE_ZPV_PROXY_API ? {
      '/api': { target: process.env.VITE_ZPV_PROXY_API, changeOrigin: true, secure: true },
    } : undefined,
  },
});
