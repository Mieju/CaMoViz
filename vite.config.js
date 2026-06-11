import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist'
  },
  test: {
    // Algorithm + engine tests run in Node — no DOM needed.
    environment: 'node',
    include: ['tests/**/*.test.js']
  }
});
