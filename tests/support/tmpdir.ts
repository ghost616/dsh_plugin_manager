import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Scratch-directory helpers for unit tests. Temp roots live under
 * `tests/.tmp` (git-ignored) so test runs need no host-machine access outside
 * the workspace; each suite gets its own unique directory so parallel spec
 * files never collide.
 */

/** Create a fresh unique scratch directory for one test suite. */
export async function makeSuiteTmp(suite: string): Promise<string> {
  const base = join(process.cwd(), 'tests', '.tmp')
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, `${suite}-`))
}

/** Recursively remove a suite scratch directory. */
export async function removeTmp(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}
