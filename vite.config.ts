import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Puerto fijo: Tauri espera el frontend en devUrl (ver src-tauri/tauri.conf.json).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
  },
});
