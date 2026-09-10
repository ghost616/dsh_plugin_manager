import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'report.json' }]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node E:/dsh_plugin_manager/node_modules/vite/bin/vite.js --port 5199 --strictPort',
    cwd: here,
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
