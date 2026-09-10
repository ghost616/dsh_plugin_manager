import { defineConfig } from 'vitest/config'

/**
 * Vitest keeps its defaults here (`include: ['**\/*.{test,spec}.?(c|m)[jt]s?(x)']`,
 * node environment, no globals, no setup files); this file only narrows the
 * collection scope.
 *
 * `.lizhu_env/` is the local test environment (an independent Playwright
 * checkout with its own `node_modules`, browser specs and run artifacts). The
 * WHOLE directory is intentionally NOT version-controlled (`.gitignore`:
 * `.lizhu_env/`) - the environment is machine-local scratch, and machine-run
 * results are recorded in the module change history instead of by committing
 * the specs.
 *
 * Being git-ignored does NOT keep it out of the unit run: vitest walks the
 * FILESYSTEM, not git's index, so whenever the directory exists locally its
 * `.spec.ts` files would be collected - and they import `@playwright/test`,
 * a dependency this package does not declare, with a second copy under
 * `.lizhu_env/e2e/node_modules` that makes them unrunnable under vitest
 * ("Playwright Test did not expect test.beforeEach() to be called here").
 * This `exclude` is therefore required on its own merits: do not remove it, and
 * do not "fix" a collected-browser-spec failure by deleting the spec.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '.lizhu_env/**'],
  },
})
