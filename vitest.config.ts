import { defineConfig } from 'vitest/config'

/**
 * Vitest keeps its defaults here (`include: ['**\/*.{test,spec}.?(c|m)[jt]s?(x)']`,
 * node environment, no globals, no setup files); this file only narrows the
 * collection scope.
 *
 * `.lizhu_env/` is the local Playwright E2E environment: an independent
 * checkout with its own `node_modules`, its own `.spec.ts` suite and run
 * artifacts. It is never part of this package - it is git-ignored, no
 * `tsconfig*.json` covers it, and its `.spec.ts` files must not be collected
 * by the unit runner (they import `@playwright/test`, which this package does
 * not depend on). Keep it excluded here instead of renaming its files.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '.lizhu_env/**'],
  },
})
