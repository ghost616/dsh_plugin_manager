import { join } from 'node:path'

/**
 * Fixed names of the manager-owned entries inside the local source repository
 * root. The manager only manages these entries; user files at the root are
 * left alone.
 */
export const MARKET_REPOSITORY_LAYOUT = {
  /** Records file v1 (plugin records keyed by stable key under a schema version). */
  recordsFile: 'plugins.json',
  /**
   * Shared harness module directory. Downloaded plugin checkouts resolve their
   * `@deepseek-ai/*` harness references upward to the links placed here, so
   * they share the single running instance of the main process.
   */
  sharedNodeModules: 'node_modules',
  /**
   * Install-conventions file read by every pnpm run inside the repository
   * tree (nearest `.npmrc` wins), keeping peer auto-install off.
   */
  installConventionsFile: '.npmrc',
} as const

/** Absolute path of the records file inside `root`. */
export function repositoryRecordsPath(root: string): string {
  return join(root, MARKET_REPOSITORY_LAYOUT.recordsFile)
}

/** Absolute path of the shared node_modules directory inside `root`. */
export function repositorySharedModulesPath(root: string): string {
  return join(root, MARKET_REPOSITORY_LAYOUT.sharedNodeModules)
}

/** Absolute path of the shared `@deepseek-ai` scope directory inside `root`. */
export function repositorySharedScopePath(root: string): string {
  return join(repositorySharedModulesPath(root), '@deepseek-ai')
}

/** Absolute path of the install-conventions file inside `root`. */
export function repositoryConventionsPath(root: string): string {
  return join(root, MARKET_REPOSITORY_LAYOUT.installConventionsFile)
}

/**
 * pnpm install conventions written at repository initialization. A downloaded
 * plugin checkout installs only its own non-harness dependencies; its
 * `@deepseek-ai/*` harness references must resolve upward to the shared links
 * under `node_modules` (the single running instance), so peer auto-install
 * stays OFF — pnpm must not materialize a second `@deepseek-ai/*` copy inside
 * a plugin checkout.
 */
export const PNPM_INSTALL_CONVENTIONS = [
  '# dsh-plugin-market — shared-harness install conventions.',
  '# A downloaded plugin checkout installs only its own non-harness',
  '# dependencies. Its @deepseek-ai/* harness references must resolve upward',
  '# to the shared links in ./node_modules (the single running instance), so',
  '# peer auto-install stays OFF: pnpm must not materialize a second',
  '# @deepseek-ai/* copy inside a plugin checkout.',
  'auto-install-peers=false',
  '',
].join('\n')
