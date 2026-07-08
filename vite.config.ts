import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the production build can be served from any sub-path.
export default defineConfig({
  plugins: [react()],
  base: './',
});
