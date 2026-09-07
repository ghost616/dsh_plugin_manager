import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessPackageResolver } from '../../src/host/market/harness.ts'

/** `@deepseek-ai/cordis` → `cordis`. */
export function harnessShortName(name: string): string {
  return name.slice(name.indexOf('/') + 1)
}

/**
 * Fabricate a fake running-instance `node_modules/@deepseek-ai` scope under
 * `base` with one minimal package per name (package.json + main file), so
 * real Node resolution and junction linking work against it.
 */
export async function scaffoldHostScope(
  base: string,
  names: readonly string[],
): Promise<string> {
  const scope = join(base, 'host', 'node_modules', '@deepseek-ai')
  for (const name of names) {
    const dir = join(scope, harnessShortName(name))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '9.9.9',
      type: 'module',
      main: 'index.js',
    }), 'utf8')
    await writeFile(join(dir, 'index.js'), 'export const marker = true\n', 'utf8')
  }
  return scope
}

/** Package resolver serving a fabricated scope (mirrors instance resolution). */
export function scopeResolver(scope: string): HarnessPackageResolver {
  return async (name) => {
    const dir = join(scope, harnessShortName(name))
    try {
      await stat(dir)
      return dir
    } catch {
      return null
    }
  }
}
