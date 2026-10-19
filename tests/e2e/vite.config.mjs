// Servidor de la interfaz para las pruebas: el mismo de `pnpm dev`, pero sin recarga en
// caliente ni vigilancia de archivos, para que un cambio en el código en medio de una
// corrida no reinicie la página que se está probando.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  root,
  plugins: [react()],
  clearScreen: false,
  // Caché propia: no se pisa con la del servidor de desarrollo si está abierto a la vez.
  cacheDir: resolve(root, 'node_modules/.vite-e2e'),
  server: { hmr: false, watch: null },
});
