#!/usr/bin/env node
/**
 * Demo verification for the single-row convergence:
 *
 *  1. Runs scripts/install-profile.mjs against a fresh demo profile directory
 *     (default <os-tmpdir>/dsh-plugin-market-demo-profile) and asserts the
 *     managed patch layer carries exactly ONE loader row (plugin-market-host),
 *     with no separate control/ui rows.
 *  2. Boots a real cordis Loader over that single row (relative entry, exactly
 *     as a dsh profile would resolve it):
 *       - idle: no Config.repositoryPath -> the row activates and stays idle
 *         without failing, and no control/record rows appear;
 *       - configured: repositoryPath points at a seeded demo repository whose
 *         records mark one plugin enabled -> the embedded control activates
 *         with the same row, rebuilds the record as a loader row, and the demo
 *         plugin resolves the shared `@deepseek-ai/cordis` to the single
 *         running instance. Loader rows stay free of plugin-market-control /
 *         plugin-market-ui ids, so there is no client-modules multi-source
 *         conflict: one package row, one browser half via dsh.client.
 *  3. Statically asserts the built artifacts (lib/index.js ESM, lib/client.js
 *     lazy-CJS closure factory) and smoke-runs the client factory in a VM.
 *
 * Requires `pnpm build` and `pnpm install` first (Loader/Include come from the
 * package devDependencies - published @deepseek-ai/cordis-plugin-loader and
 * cordis-plugin-include). Read-only towards any dsh checkout: only the demo
 * profile directory (under the OS temp dir) is written.
 *
 * Usage: node scripts/verify-load.mjs [demoProfileDir]
 */
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import vm from 'node:vm'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { installIntoProfile as runInstall } from './install-profile.mjs'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = resolve(process.argv[2] ?? join(tmpdir(), 'dsh-plugin-market-demo-profile'))
const HOST_ID = 'plugin-market-host'
const FORBIDDEN_IDS = new Set(['plugin-market-control', 'plugin-market-ui'])

const failures = []
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

async function until(description, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`)
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 25))
  }
}

/** Parse the - insert: rows of the managed patch layer. */
function parseRows(patchFile) {
  const lines = readFileSync(patchFile, 'utf8').split(/\r?\n/)
  const rows = []
  let inInsert = false
  let current = null
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '- insert:') { inInsert = true; continue }
    if (!inInsert) continue
    const idMatch = line.match(/^\s+- id:\s+(.+)$/)
    if (idMatch) {
      if (current) rows.push(current)
      current = { id: idMatch[1].trim(), name: '', disabled: false }
      continue
    }
    if (!current) continue
    const nameMatch = line.match(/^\s+name:\s+(.+)$/)
    if (nameMatch) { current.name = nameMatch[1].trim(); continue }
    const disabledMatch = line.match(/^\s+disabled:\s+(.+)$/)
    if (disabledMatch) { current.disabled = String(disabledMatch[1].trim()).toLowerCase() === 'true' }
  }
  if (current) rows.push(current)
  return rows
}

/** Render rows to a plain include entry list (optionally with a row config). */
function rowsToYaml(rows, extraConfigByRowId = {}) {
  const body = rows.map(row => {
    const lines = [`- id: ${row.id}`, `  name: ${row.name}`]
    if (row.disabled) lines.push('  disabled: true')
    const config = extraConfigByRowId[row.id]
    if (config !== undefined) {
      lines.push('  config:')
      for (const [key, value] of Object.entries(config)) {
        lines.push(`    ${key}: ${JSON.stringify(value)}`)
      }
    }
    return lines.join('\n')
  }).join('\n')
  return `${body}\n`
}

/** Fresh snapshot of the loader's entry list (recomputed per inspection). */
function snapshotEntries(ctx) {
  return [...ctx.loader.entries()]
}

/** Mount a Loader over a composed entry list rooted at `demoDir`. */
async function mountLoader(demoDir, composedPath) {
  const context = new Context()
  context.baseUrl = pathToFileURL(`${demoDir}/`).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(composedPath).href } })
  await context.loader.await()
  return context
}

function singleRowChecks(ctx, label) {
  const entries = snapshotEntries(ctx)
  const host = entries.find(entry => entry.options.id === HOST_ID)
  check(`${label}: loader resolved the single plugin-market-host row`, host !== undefined, host ? `entry=${host.options.name}` : '')
  check(`${label}: exactly one package-main row is loaded`,
    entries.filter(entry => entry.options.name.includes('lib/index.js')).length === 1)
  check(`${label}: no separate control/ui loader rows (single client-modules source)`,
    !entries.some(entry => FORBIDDEN_IDS.has(entry.options.id)))
  return { entries, host }
}

async function verifyIdleRow(demoDir) {
  const rows = parseRows(join(demoDir, 'cordis.patch.yml'))
  const composed = join(demoDir, '.composed.idle.yml')
  writeFileSync(composed, rowsToYaml(rows))
  const ctx = await mountLoader(demoDir, composed)
  try {
    const { host } = singleRowChecks(ctx, 'idle')
    check('idle (no repositoryPath): host row activates without failing',
      host?.fiber !== undefined && host.fiber.state !== 'failed', `state=${String(host?.fiber?.state)}`)
    check('idle: no record-driven rows were created',
      !snapshotEntries(ctx).some(entry => entry.options.id.startsWith('gh-')))
  } finally {
    await ctx.fiber.dispose()
  }
}

async function verifyConfiguredRow(demoDir) {
  const repoDir = join(demoDir, 'market-repo')
  const checkoutDir = join(repoDir, 'gh-demo-greet')
  mkdirSync(checkoutDir, { recursive: true })
  writeFileSync(join(checkoutDir, 'plugin.mjs'), [
    "import { Context } from '@deepseek-ai/cordis'",
    '',
    'export const name = \'demo-greet\'',
    'export const inject = []',
    'export function apply() {}',
    '// Single-instance probe: the class identity of the running cordis runtime.',
    'export const appliedCordisContext = Context',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(repoDir, 'plugins.json'), `${JSON.stringify({
    schemaVersion: 1,
    records: {
      'gh-demo-greet': {
        key: 'gh-demo-greet',
        source: { kind: 'github', repository: 'demo/greet', version: null, commit: null },
        localDirName: 'gh-demo-greet',
        entry: 'plugin.mjs',
        installedAt: new Date().toISOString(),
        enabled: true,
        trusted: 'untrusted',
        trustedAt: null,
      },
    },
  }, null, 2)}\n`, 'utf8')

  const rows = parseRows(join(demoDir, 'cordis.patch.yml'))
  const composed = join(demoDir, '.composed.configured.yml')
  writeFileSync(composed, rowsToYaml(rows, { [HOST_ID]: { repositoryPath: repoDir } }))
  const ctx = await mountLoader(demoDir, composed)
  try {
    const { host } = singleRowChecks(ctx, 'configured')
    check('configured: host row activates', host?.fiber !== undefined && host.fiber.state !== 'failed',
      `state=${String(host?.fiber?.state)}`)

    // The embedded control rebuilds the enabled record as a real loader row.
    await until('control rebuild registers the enabled record row', () =>
      snapshotEntries(ctx).some(entry => entry.options.id === 'gh-demo-greet'))
    const entries = snapshotEntries(ctx)
    const recordRow = entries.find(entry => entry.options.id === 'gh-demo-greet')
    check('configured: control logic activated along the row (record row exists)',
      recordRow !== undefined, recordRow ? `entry=${recordRow.options.name}` : '')
    check('configured: record plugin reached the active phase',
      recordRow?.fiber !== undefined && recordRow.fiber.state !== 'failed',
      `state=${String(recordRow?.fiber?.state)}`)

    // Single instance: the demo plugin resolves cordis to the running instance.
    const moduleName = recordRow.options.name
    const plugin = await import(moduleName)
    check('configured: record plugin shares the single cordis instance',
      plugin.appliedCordisContext === Context, `module=${moduleName}`)
  } finally {
    await ctx.fiber.dispose()
  }
}

async function verifyArtifacts() {
  const index = join(ROOT, 'lib', 'index.js')
  const client = join(ROOT, 'lib', 'client.js')
  check('pnpm build produced lib/index.js', existsSync(index))
  check('pnpm build produced lib/client.js', existsSync(client))

  const indexCode = readFileSync(index, 'utf8')
  check('lib/index.js is the ESM single-row composer entry',
    indexCode.includes('plugin-market-host') && indexCode.includes('marketControl') && indexCode.includes('export'),
    `head=${indexCode.slice(0, 40).replace(/\n/g, ' ')}`)

  const code = readFileSync(client, 'utf8')
  check('lib/client.js opens the ModuleLoader handoff', code.startsWith('window.__ModuleLoader__.load({'))
  const codeBody = code.replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd()
  check('lib/client.js closes the closure factory', codeBody.endsWith('});') && codeBody.includes('return module.exports;'))
  let captured
  const sandbox = {
    console,
    window: { __ModuleLoader__: { load(handoff) { captured = handoff } } },
    require(specifier) { return {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  check('client factory registered under the package id', captured?.id === 'dsh-plugin-market')
  const loaded = captured.factory(sandbox.require)
  check('client factory returns an exports object', typeof loaded === 'object' && loaded !== null)
}

async function main() {
  rmSync(DEMO, { recursive: true, force: true })
  mkdirSync(DEMO, { recursive: true })
  const report = runInstall(DEMO, { mode: 'junction' })
  console.log('install-profile:', JSON.stringify(report))
  const linkedEntry = join(DEMO, 'plugins', 'dsh-plugin-market', 'lib', 'index.js')
  check('demo profile resolves the built host entry through the link', existsSync(linkedEntry))

  const rows = parseRows(join(DEMO, 'cordis.patch.yml'))
  check('patch layer declares exactly one row (plugin-market-host)',
    rows.length === 1 && rows[0].id === HOST_ID && !rows[0].disabled, `rows=${rows.map(row => row.id).join(',')}`)

  await verifyArtifacts()
  await verifyIdleRow(DEMO)
  await verifyConfiguredRow(DEMO)

  console.log('demo profile:', DEMO)
  if (failures.length > 0) {
    console.error(`\nverification failed (${failures.length}):\n- ${failures.join('\n- ')}`)
    process.exit(1)
  }
  console.log('\nverification passed')
}

await main()