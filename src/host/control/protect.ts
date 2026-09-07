/**
 * Protection policy of the market control surface.
 *
 * The manager only ever manages plugins recorded in its own repository, but
 * two guard rails are still enforced at the control boundary:
 * - reserved loader-row ids of this package (and structural ids that can never
 *   legitimately appear in a record) are refused as managed-plugin keys;
 * - a loader entry whose module resolves inside this package's own directory
 *   tree is treated as the manager itself and is never removable.
 */

import { fileURLToPath } from 'node:url'
import { isPathInside, packageRootOfModuleUrl } from './entry-name.ts'

/** Loader row ids this package ships in the profile patch (self rows). */
export const MARKET_SELF_ROW_IDS: readonly string[] = [
  'plugin-market-host',
  'plugin-market-control',
  'plugin-market-ui',
]

/** Structural ids that must never be managed, even if a record names them. */
export const PROTECTED_RESERVED_IDS: readonly string[] = [
  'include',
  'loader',
  'cordis',
]

/** True when a raw key may never be toggled or removed by the market. */
export function isProtectedRecordKey(key: string): boolean {
  if (PROTECTED_RESERVED_IDS.includes(key)) return true
  if (MARKET_SELF_ROW_IDS.includes(key)) return true
  // Any future self row of this package keeps the market-self prefix.
  return key.startsWith('plugin-market-')
}

/** Policy bundle handed to the controller. */
export interface ProtectionPolicy {
  isProtectedKey(key: string): boolean
  /**
   * True when a loader module specifier points inside this package's own tree
   * (the manager acting on itself). `selfModuleUrl` is the running module of
   * the control entry; the comparison uses the nearest owning package root.
   */
  isSelfModule(moduleName: string): boolean
}

/**
 * Build the production policy from the control entry's own module URL.
 * A failing package-root probe degrades to reserved-key protection only.
 */
export function createProtectionPolicy(selfModuleUrl: string | undefined): ProtectionPolicy {
  const ownPackageRoot = selfModuleUrl === undefined
    ? null
    : packageRootOfModuleUrl(selfModuleUrl)
  return {
    isProtectedKey: isProtectedRecordKey,
    isSelfModule(moduleName) {
      if (ownPackageRoot === null) return false
      if (!moduleName.startsWith('file://')) return false
      let filePath: string
      try {
        filePath = fileURLToPath(moduleName)
      } catch {
        return false
      }
      return isPathInside(ownPackageRoot, filePath)
    },
  }
}