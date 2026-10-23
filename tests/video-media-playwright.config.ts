import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: 'video-media.spec.ts',
  timeout: 120_000,
  workers: 1,
  outputDir: '../test-results/video-media',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    headless: true,
    launchOptions: { args: ['--enable-precise-memory-info'] },
  },
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
