import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: API on :3000. Set APP_ORIGIN=http://localhost:5173 and COOKIE_SECURE=false in the server .env.
const api = { target: 'http://localhost:3000', changeOrigin: false };
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/auth', '/users', '/channels', '/conversations', '/contacts', '/audit', '/healthz'].map((p) => [p, api])),
  },
});
