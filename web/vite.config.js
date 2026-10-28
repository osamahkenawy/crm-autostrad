import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API listens on API_PORT (default 4000); /api calls from the browser are proxied to it.
const apiPort = process.env.API_PORT || 4000;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
