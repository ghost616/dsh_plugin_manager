import { defineConfig } from 'vitest/config'

/**
 * Vitest keeps its defaults here (`include: ['**\/*.{test,spec}.?(c|m)[jt]s?(x)']`,
 * node environment, no globals, no setup files); this file only narrows the
 * collection scope.
 *
 * `.lizhu_env/e2e/` is the local Playwright browser-spec environment: it has
 * its own `node_modules` and harness config, and its `.spec.ts` files import
 * `@playwright/test` - a dependency this package does not declare, and whose
 * second copy under `.lizhu_env/e2e/node_modules` makes them unrunnable under
 * vitest anyway ("Playwright Test did not expect test.beforeEach() to be
 * called here"). Its SOURCES ARE VERSION-CONTROLLED (only artifacts are
 * ignored, see .gitignore), so this exclusion is the one and only thing that
 * keeps them out of the unit run - do not remove it, and do not "fix" a
 * collected-browser-spec failure by deleting the file.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '.lizhu_env/**'],
  },
})
