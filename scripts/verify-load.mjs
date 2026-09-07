#!/usr/bin/env node
/**
 * Demo verification for the framework skeleton:
 *
 *  1. Runs scripts/install-profile.mjs against a fresh demo profile directory
 *     (default <os-tmpdir>/dsh-plugin-market-demo-profile) - junction + patch
 *     rows; the demo lives OUTSIDE this repository so a copy fallback is safe.
 *  2. Boots a real cordis Loader over a composed entry list parsed from that
 *     patch layer (relative rows exactly as a dsh profile would resolve them)
 *     and asserts the plugin-market-host placeholder activates.
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const failures = []
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Extract the - insert: rows of the managed patch layer into plain rows. */
function composeRows(patchFile, outFile) {
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
  const body = rows.map(row => {
    const linesOut = [`- id: ${row.id}`, `  name: ${row.name}`]
    if (row.disabled) linesOut.push('  disabled: true')
    return linesOut.join('\n')
  }).join('\n')
  writeFileSync(outFile, `${body}\n`)
  return rows
}

async function verifyLoaderLoad(demoDir) {
  const composed = join(demoDir, '.composed.cordis.yml')
  const rows = composeRows(join(demoDir, 'cordis.patch.yml'), composed)
  check('patch layer declares plugin-market-host row', rows.some(row => row.id === 'plugin-market-host' && !row.disabled))
  check('patch layer declares disabled control/ui rows', rows.filter(row => ['plugin-market-control', 'plugin-market-ui'].includes(row.id) && row.disabled).length === 2)

  const context = new Context()
  context.baseUrl = pathToFileURL(`${demoDir}/`).href + '/'
  try {
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(composed).href } })
    await context.loader.await()

    const entries = context.loader.entries()
    const host = entries.find(entry => entry.options.id === 'plugin-market-host')
    check('loader resolved the plugin-market-host entry', host !== undefined, host ? `entry=${host.options.name}` : '')
    check('loader activated the placeholder plugin', host?.fiber !== undefined && host.fiber.state !== 'failed', host ? `state=${String(host?.fiber?.state)}` : '')
    const control = entries.find(entry => entry.options.id === 'plugin-market-control')
    const ui = entries.find(entry => entry.options.id === 'plugin-market-ui')
    check('disabled control/ui rows stayed inert', (control?.disabled ?? true) && (ui?.disabled ?? true))

  } finally {
    await context.fiber.dispose()
  }
}

async function verifyArtifacts() {
  const index = join(ROOT, 'lib', 'index.js')
  const client = join(ROOT, 'lib', 'client.js')
  check('pnpm build produced lib/index.js', existsSync(index))
  check('pnpm build produced lib/client.js', existsSync(client))

  const indexCode = readFileSync(index, 'utf8')
  check('lib/index.js is the ESM host entry', indexCode.includes('plugin-market-host') && indexCode.includes('export'), `head=${indexCode.slice(0, 40).replace(/\n/g, ' ')}`)

  const code = readFileSync(client, 'utf8')
  check('lib/client.js opens the ModuleLoader handoff', code.startsWith('window.__ModuleLoader__.load({'))
  const codeBody = code.replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd()
  check('lib/client.js closes the closure factory', codeBody.endsWith('});') && codeBody.includes('return module.exports;'))
  let captured
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load(handoff) { captured = handoff },
      },
    },
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

  await verifyArtifacts()
  await verifyLoaderLoad(DEMO)

  console.log('demo profile:', DEMO)
  if (failures.length > 0) {
    console.error(`\nverification failed (${failures.length}):\n- ${failures.join('\n- ')}`)
    process.exit(1)
  }
  console.log('\nverification passed')
}

await main()
