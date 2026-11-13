import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: './tests/ui',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3847',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 3847',
    url: 'http://127.0.0.1:3847/healthz',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      OPENRABBIT_ADMIN_TOKEN: 'ui-test-token',
      OPENRABBIT_PUBLIC_URL: 'https://review.example.com',
      OPENRABBIT_DATA_DIR: path.resolve('.playwright-data'),
    },
  },
});
