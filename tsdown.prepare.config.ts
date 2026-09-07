import { bundleConfigs, nodeLibraryConfig } from './tsdown.shared.ts'

/**
 * Git-install `prepare` build: transpile src directly with tsdown.
 * Self-contained - no project references, no tsc, no type checking - so a
 * source clone can produce runnable lib/index.js + lib/client.js + lib/control.js
 * after a pnpm git install (see README "Installing from a git host").
 */
export default [
  ...bundleConfigs('src/index.ts', 'src/client/index.ts'),
  nodeLibraryConfig({ control: 'src/host/control/index.ts' }),
]