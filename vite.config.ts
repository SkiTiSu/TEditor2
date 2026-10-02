import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'formula-vendor': ['@formulajs/formulajs', 'crypto-js'],
        },
      },
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
});
