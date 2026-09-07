/**
 * Loader module-specifier derivation for managed plugin records.
 *
 * A managed plugin's loader entry names the checkout entry file through an
 * absolute `file:` URL (`pathToFileURL`), so loading never depends on the
 * Loader's `baseUrl` (which points at the dsh profile, not at the user-chosen
 * plugin source repository). Node's ESM resolver walks upward from that file
 * and finds the repository's shared `node_modules/@deepseek-ai` scope, whose
 * junction links resolve to the single running harness instance.
 */

import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginMarketRecord } from '../../types.ts'

/** Conventional entry file of a checkout that predates entry metadata. */
export const DEFAULT_PLUGIN_ENTRY = 'index.js'

/** Absolute entry file path of one managed plugin inside the repository. */
export function resolveEntryPath(root: string, record: PluginMarketRecord): string {
  return join(root, record.localDirName, record.entry ?? DEFAULT_PLUGIN_ENTRY)
}

/** Loader module specifier (absolute file URL) of one managed plugin. */
export function entryModuleName(root: string, record: PluginMarketRecord): string {
  return pathToFileURL(resolveEntryPath(root, record)).href
}

/** Absolute checkout directory of one managed plugin inside the repository. */
export function entryDirectoryPath(root: string, record: PluginMarketRecord): string {
  return join(root, record.localDirName)
}

/**
 * True when `candidate` stays inside `directory` (or equals it). Both must be
 * absolute; the comparison is canonical (no `.`/`..` normalization beyond the
 * OS `join` output). Used before any destructive filesystem removal.
 */
export function isPathInside(directory: string, candidate: string): boolean {
  if (!isAbsolute(directory) || !isAbsolute(candidate)) return false
  const rel = relative(directory, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Absolute package root of a module (nearest ancestor owning package.json). */
export function packageRootOfModuleUrl(moduleUrl: string): string | null {
  let dir = dirname(moduleUrl)
  // The URL may be the emitted lib or dev src; climb until a package.json owns
  // the directory, but never climb past the volume root.
  for (;;) {
    const marker = `${dir}${sep}package.json`
    const { existsSync } = requireExistsSync()
    if (existsSync(marker)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Kept behind a function so bundling stays side-effect free; NodeFs parity is
// enough here (no injectable fs needed for a boot-time path guard).
function requireExistsSync(): { existsSync(path: string): boolean } {
  const { existsSync } = require('node:fs') as { existsSync(path: string): boolean }
  return { existsSync }
}