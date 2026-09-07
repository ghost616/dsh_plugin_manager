#!/usr/bin/env node
/**
 * dsh-plugin-market profile self-load recipe.
 *
 * Makes the package's built artifacts loadable from a dsh profile without
 * publishing or git-installing the package: it links (junction by default,
 * recursive copy with --mode copy) this repository into
 *   <profileDir>/plugins/dsh-plugin-market
 * and appends the plugin rows to the profile's own cordis.patch.yml, whose
 * `name` entries are relative to the profile directory. Idempotent: re-running
 * never duplicates the link or the rows. Remove with --uninstall.
 *
 * Usage:
 *   node scripts/install-profile.mjs <profileDir> [--mode junction|copy]
 *   node scripts/install-profile.mjs <profileDir> --uninstall
 *
 * DSH_HOME profiles live at $DSH_HOME/profiles/<name> (e.g. .../.dsh/profiles/web).
 * Editing a live profile's cordis.patch.yml takes effect only after a restart
 * (or a live patch reload where the profile enables it).
 *
 * Note: the profile directory must live OUTSIDE this repository. A recursive
 * copy of the repo into its own subtree is illegal, and a junction inside the
 * repo would create a cycle; both modes refuse it.
 */
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUB_DIR = join('plugins', 'dsh-plugin-market')
const SOURCE_MARKER = '.dsh-plugin-market.source'
const PATCH_MARKER = '# dsh-plugin-market self-load'
const COPY_SKIP = new Set(['.git', 'node_modules', '.module_agent', '.demo-profile'])

export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** True when `dir` is inside this repository (copy of the repo would be cyclic). */
function insideRepo(dir) {
  const repo = realpathSync(repoRoot())
  const rel = relative(repo, resolve(dir))
  if (rel === '') return true
  const escapesUp = rel === '..' || rel.startsWith(`..${sep}`)
  return !escapesUp
}

/** Copy the repo (artifacts included) into `target`, skipping heavy dirs. */
function copyRepo(repo, target) {
  cpSync(repo, target, {
    recursive: true,
    filter: (src) => !COPY_SKIP.has(src.split(/[\\/]/).pop()),
  })
  writeFileSync(join(target, SOURCE_MARKER), `${repo}\n`)
}

/**
 * Create or refresh the plugins/dsh-plugin-market link. Returns a short
 * description of what happened.
 */
export function linkPluginDir(profileDir, mode = 'junction') {
  const repo = repoRoot()
  const linkPath = join(profileDir, SUB_DIR)
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      if (realpathSync(linkPath) === realpathSync(repo)) return 'link exists'
      throw new Error(
        `refusing to touch ${linkPath}: it links to ${realpathSync(linkPath)}, not ${repo}; remove it first or pass --uninstall`,
      )
    }
    if (stat.isDirectory()) {
      const marker = join(linkPath, SOURCE_MARKER)
      if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === repo) return 'copy exists'
      throw new Error(`refusing to touch ${linkPath}: it is a directory not managed by this script`)
    }
    throw new Error(`refusing to touch ${linkPath}: unexpected file type`)
  }
  ensureDir(dirname(linkPath))
  if (mode === 'copy') {
    if (insideRepo(profileDir)) {
      throw new Error(
        `profile directory ${profileDir} is inside this repository; a copy would recurse into itself - ` +
        'use --mode junction on a junction-capable host, or point at a profile outside the repository ' +
        '(profiles live under $DSH_HOME/profiles/<name>)',
      )
    }
    copyRepo(repo, linkPath)
    return 'copy created'
  }
  try {
    symlinkSync(repo, linkPath, 'junction')
    return 'link created'
  } catch (error) {
    if (insideRepo(profileDir)) {
      throw new Error(
        `cannot create a junction at ${linkPath} (${error.message}) and the profile directory is inside ` +
        'this repository, where a copy fallback would recurse into itself; point the recipe at a profile ' +
        'outside the repository or run on a junction-capable host',
      )
    }
    console.warn(`junction creation failed (${error.message}); falling back to a copy`)
    copyRepo(repo, linkPath)
    return 'copy created (junction fallback)'
  }
}

/** The patch rows appended to the profile layer (relative to the profile dir). */
function rowsBlock() {
  return [
    `# ${PATCH_MARKER} (managed by scripts/install-profile.mjs)`,
    '# Plugin source: plugins/dsh-plugin-market (junction/copy of the repository).',
    '# Rows resolve relative to this profile directory. plugin-market-control and',
    '# plugin-market-ui stay disabled until their entries ship with their modules;',
    '# remove everything with: node scripts/install-profile.mjs <profileDir> --uninstall',
    '- insert:',
    '    - id: plugin-market-host',
    "      name: './plugins/dsh-plugin-market/lib/index.js'",
    '    - id: plugin-market-control',
    "      name: './plugins/dsh-plugin-market/lib/control.js'",
    '      disabled: true',
    '    - id: plugin-market-ui',
    "      name: './plugins/dsh-plugin-market/lib/ui.js'",
    '      disabled: true',
    '',
  ].join('\n')
}

/** Append the managed rows to <profileDir>/cordis.patch.yml (idempotent). */
export function patchProfile(profileDir) {
  const file = join(profileDir, 'cordis.patch.yml')
  const block = rowsBlock()
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8')
    if (current.includes(PATCH_MARKER)) return 'rows already present'
    const text = current.endsWith('\n') ? current : `${current}\n`
    writeFileSync(file, `${text}\n${block}`)
    return 'rows appended'
  }
  const header = [
    '# User patch layer for this dsh profile (managed by scripts/install-profile.mjs).',
    '# Applied after every bundle layer; see README "Profile self-load".',
    '',
  ].join('\n')
  writeFileSync(file, `${header}${block}`)
  return 'rows appended (patch file created)'
}

/** One-shot, idempotent self-load install used by the CLI and verify script. */
export function installIntoProfile(profileDir, { mode = 'junction' } = {}) {
  const link = linkPluginDir(profileDir, mode)
  const patch = patchProfile(profileDir)
  return { profileDir, mode, link, patch }
}

/** Remove the link/copy and the managed rows (best effort on the text). */
export function uninstallFromProfile(profileDir) {
  const linkPath = join(profileDir, SUB_DIR)
  if (existsSync(linkPath)) {
    rmSync(linkPath, { recursive: true, force: true })
    console.log(`removed ${linkPath}`)
  }
  const file = join(profileDir, 'cordis.patch.yml')
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8')
    const index = text.indexOf(PATCH_MARKER)
    if (index >= 0) {
      const rest = text.slice(0, index).replace(/\s+$/, '')
      if (rest === '') {
        rmSync(file, { force: true })
        console.log(`removed ${file} (only managed rows remained)`)
      } else {
        writeFileSync(file, `${rest}\n`)
        console.log(`stripped managed rows from ${file}`)
      }
    }
  }
}

function usage() {
  console.error('usage: node scripts/install-profile.mjs <profileDir> [--mode junction|copy] [--uninstall]')
  process.exit(1)
}

function main() {
  const argv = process.argv.slice(2)
  const profileArg = argv.find(arg => !arg.startsWith('--'))
  const uninstall = argv.includes('--uninstall')
  const modeIndex = argv.indexOf('--mode')
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : 'junction'
  if (!profileArg) usage()
  if (mode !== 'junction' && mode !== 'copy') usage()
  const profileDir = resolve(profileArg)
  if (!existsSync(profileDir)) ensureDir(profileDir)
  if (uninstall) {
    uninstallFromProfile(profileDir)
    return
  }
  console.log(JSON.stringify(installIntoProfile(profileDir, { mode }), null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}