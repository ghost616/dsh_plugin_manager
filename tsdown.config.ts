import { bundleConfigs, nodeLibraryConfig } from './tsdown.shared.ts'

/**
 * Ordinary build: bundle the tsc emission under lib/types (run after tsc -b).
 * The main Host half (single-row composer) lands at lib/index.js, the browser
 * half at lib/client.js, and the composable control sub-entry at lib/control.js
 * (named chunk of the second Node config) - exported as ./control for hosts
 * embedding the control directly; it is not a loader row.
 */
export default [
  ...bundleConfigs('lib/types/index.js', 'lib/types/client/index.js'),
  nodeLibraryConfig({ control: 'lib/types/host/control/index.js' }),
]
