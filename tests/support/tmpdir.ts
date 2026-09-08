import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Scratch-directory helpers for unit tests.
 *
 * Default temp root is `tests/.tmp` (git-ignored) so runs need no host-machine
 * access outside the workspace. Repository-open suites (market-open,
 * market-harness) additionally create directory junctions into the scratch
 * root, so the root must live on a link-capable volume: when the workspace
 * volume rejects link creation (e.g. an overlay/exFAT volume), the helper
 * transparently falls back to the OS temp dir. The choice is probed once per
 * process and cached; every suite still gets its own unique directory so
 * parallel spec files never collide.
 */

let basePromise: Promise<string> | null = null

/** Can `dir` host directory links? Probes with one junction and removes it. */
async function supportsDirLinks(dir: string): Promise<boolean> {
  const target = join(dir, `.linkprobe-${process.pid}`)
  const link = `${target}-link`
  try {
    await mkdir(target, { recursive: true })
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    await rm(link, { recursive: true, force: true })
    return true
  } catch {
    return false
  } finally {
    await rm(target, { recursive: true, force: true }).catch(() => {})
  }
}

/** Resolve the link-capable scratch base once, caching the choice. */
function scratchBase(): Promise<string> {
  if (basePromise === null) {
    basePromise = (async () => {
      const workspaceBase = join(process.cwd(), 'tests', '.tmp')
      await mkdir(workspaceBase, { recursive: true })
      if (await supportsDirLinks(workspaceBase)) return workspaceBase
      const osBase = join(tmpdir(), 'dsh-plugin-market-tests')
      await mkdir(osBase, { recursive: true })
      return osBase
    })()
  }
  return basePromise
}

/** Create a fresh unique scratch directory for one test suite. */
export async function makeSuiteTmp(suite: string): Promise<string> {
  const base = await scratchBase()
  return mkdtemp(join(base, `${suite}-`))
}

/** Recursively remove a suite scratch directory. */
export async function removeTmp(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}