import { bundleConfigs, nodeLibraryConfig } from './tsdown.shared.ts'

/**
 * Ordinary build: bundle the tsc emission under lib/types (run after tsc -b).
 * The main Host half lands at lib/index.js, the browser half at lib/client.js,
 * and the plugin-market-control row entry at lib/control.js (named chunk of
 * the second Node config).
 */
export default [
  ...bundleConfigs('lib/types/index.js', 'lib/types/client/index.js'),
  nodeLibraryConfig({ control: 'lib/types/host/control/index.js' }),
]
