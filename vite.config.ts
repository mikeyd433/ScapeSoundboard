import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri serves the dev server on a fixed port and expects a fixed, non-obfuscated
// build output. `clearScreen: false` keeps Rust's compiler output visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2021',
    sourcemap: false,
  },
});
