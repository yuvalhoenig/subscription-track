import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is called through this proxy in development so the browser
    // sees one origin: no CORS preflight, and the refresh cookie is
    // first-party. Production builds talk to VITE_API_URL directly.
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Electron loads the bundle from disk via a custom protocol, so asset
    // URLs must be relative rather than rooted at /.
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
  // Relative base so the same build works from a web server and from
  // Electron's file-based loader.
  base: './',
});
