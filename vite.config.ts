import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages project site served at /wkw-deckbuilder/
export default defineConfig({
  plugins: [react()],
  base: '/wkw-deckbuilder/',
});

