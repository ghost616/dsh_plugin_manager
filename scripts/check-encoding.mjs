#!/usr/bin/env node
/**
 * Repository encoding / whitespace pre-flight.
 *
 * Why this exists: this project was hit by two representation accidents that no
 * other gate can see - a lossy PowerShell round-trip re-encoded a UTF-8 source
 * file as cp1252 (em dashes became `?` / 0x3F), and mojibake sequences
 * (U+00A2-U+00FF pairs)
 * reached a file that was perfectly valid syntax. `tsc` and `vitest` accept both,
 * so the damage only shows up as garbled user-visible copy far downstream.
 * This script is the cheap, dependency-free gate for that class of defect.
 *
 * Scope: files that are TRACKED by git (`git ls-files`), minus:
 *   - a configured ignore prefix (the local test environment), and
 *   - binaries (a NUL byte anywhere in the file).
 *
 * Checks, with the calibration that keeps them free of false positives:
 *   ERRORS (exit 1)
 *     1. invalid UTF-8 byte sequence (`TextDecoder` fatal); the offending byte
 *        offset is reported with a hex/excerpt window.
 *     2. C1 control characters (U+0080-U+009F). Legitimate text - including
 *        Chinese and typographic dashes/quotes - never contains them; they are
 *        the signature of UTF-8 bytes decoded as Latin-1 (e.g. a cp1252 en dash
 *        U+2013 stored as `0xC2 0x96`).
 *     3. U+FFFD REPLACEMENT CHARACTER: an irreversible decode loss.
 *     4. cp1252 mojibake pairs (U+00C2 / U+00C3 / U+00E2 followed by a
 *        continuation byte, the classic corrupted-dash shape).
 *     5. `git diff --check` whitespace rules (trailing whitespace,
 *        space-before-tab, ...) over the worktree and, when a commit exists,
 *        the index; the exact subset is git's own, so this stays
 *        "git diff --check-like" rather than a second, drifting opinion.
 *   WARNINGS (never fail the run)
 *     6. UTF-8 BOM at the start of a file (this repo is BOM-less).
 *     7. blank line(s) at end of file (git's `blank-at-eof` rule).
 *        Missing a FINAL newline is not flagged at all: git's default rule set
 *        does not include `missing-at-eof`, and many tracked files predate it.
 *     8. NOT DETECTED ON PURPOSE - a bare `?` where a dash/quote used to be.
 *        The 0x3F accident is real, but no shape of it can be told apart from
 *        this codebase's ordinary code: ` ? ` is the ternary separator in
 *        nearly every TypeScript file here (a candidate rule matched 275
 *        legitimate lines and zero defects). The unambiguous neighbours above
 *        (C1 characters, mojibake pairs) already catch the same accidents.
 *
 * Usage: `node scripts/check-encoding.mjs` (wired into `npm test` before the
 * type checks; run it standalone via `npm run check:encoding`).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** The one directory excluded wholesale (the local, never-committed test env). */
const IGNORED_PREFIX = '.lizhu_env/'

const C1_RANGE = /[\u0080-\u009F]/
const REPLACEMENT = /\uFFFD/
const MOJIBAKE = /[\u00C2\u00C3\u00E2][\u0080-\u00BF]/

/** Run one git command, returning stdout and exit code. */
function git(args) {
  try {
    const stdout = execFileSync('git', [...args, '--'], { encoding: 'utf8' })
    return { stdout, code: 0 }
  } catch (error) {
    return {
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      code: typeof error.status === 'number' ? error.status : 1,
    }
  }
}

/** `git ls-files`; the pathspec empty string means "everything". */
function trackedFiles(pathspec) {
  const { stdout } = git(['ls-files', '-z', ...(pathspec === undefined ? [] : [pathspec])])
  return stdout.split('\0').filter((entry) => entry.length > 0)
}

function isBinary(bytes) {
  return bytes.includes(0)
}

/** Byte offset of the first invalid UTF-8 sequence, or -1 when the text is valid. */
function decodeStrict(bytes) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), badOffset: -1 }
  } catch {
    // Locate the first bad sequence by bisecting on the fatal decoder.
    let low = 0
    let high = bytes.length
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2)
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, mid))
        low = mid
      } catch {
        high = mid - 1
      }
    }
    return { text: null, badOffset: Math.min(low, bytes.length - 1) }
  }
}

/** 1-based line numbers of every match, capped so one bad file cannot flood the log. */
function lineNumbers(text, pattern, cap = 20) {
  const numbers = []
  // Fresh global regex per call: a shared `lastIndex` silently skips lines.
  const scanner = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)
  for (const [index, line] of text.split('\n').entries()) {
    if (scanner.test(line)) {
      numbers.push(index + 1)
      if (numbers.length >= cap) break
    }
  }
  return numbers
}

function hexWindow(bytes, offset, radius = 6) {
  const start = Math.max(0, offset - radius)
  const end = Math.min(bytes.length, offset + radius + 1)
  const slice = bytes.subarray(start, end)
  const hex = [...slice].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
  const text = new TextDecoder('utf-8').decode(slice).replace(/[\u0000-\u001F\u007F]/g, '.')
  return `offset ${offset}: [${hex}] ~ ${JSON.stringify(text)}`
}

const violations = []
const warnings = []

function error(file, line, message) {
  violations.push(`${file}${line === undefined ? '' : `:${line}`}: ${message}`)
}

function warn(file, line, message) {
  warnings.push(`${file}${line === undefined ? '' : `:${line}`}: ${message}`)
}

/* ---------------------------------------------------------------------------- */
/* 1. Text/encoding checks over the tracked corpus                            */
/* ---------------------------------------------------------------------------- */

const files = trackedFiles(undefined).filter((file) => !file.startsWith(IGNORED_PREFIX))
let scanned = 0
let skippedBinary = 0

for (const file of files) {
  let bytes
  try {
    bytes = readFileSync(file)
  } catch {
    // Tracked but missing from the worktree (deleted, not yet staged): the
    // index still lists it; nothing to inspect.
    continue
  }
  if (bytes.length === 0) continue
  if (isBinary(bytes)) {
    skippedBinary += 1
    continue
  }
  scanned += 1

  const { text, badOffset } = decodeStrict(bytes)
  if (text === null) {
    error(file, undefined, `invalid UTF-8 byte sequence (${hexWindow(bytes, badOffset)})`)
    continue
  }

  if (text.startsWith('\uFEFF')) {
    warn(file, 1, 'UTF-8 BOM at start of file (this repo is BOM-less UTF-8)')
  }

  const c1 = lineNumbers(text, C1_RANGE)
  if (c1.length > 0) {
    error(file, c1[0], `C1 control character(s) (U+0080-U+009F) on line(s) ${c1.join(', ')} - UTF-8 bytes decoded as Latin-1/cp1252`)
  }

  const replacement = lineNumbers(text, REPLACEMENT)
  if (replacement.length > 0) {
    error(file, replacement[0], `U+FFFD replacement character on line(s) ${replacement.join(', ')} - a decode already lost data`)
  }

  const mojibake = lineNumbers(text, MOJIBAKE)
  if (mojibake.length > 0) {
    error(file, mojibake[0], `cp1252 mojibake pair (two bogus accented chars) on line(s) ${mojibake.join(', ')} - UTF-8 bytes re-read as Latin-1 where a dash/quote belongs`)
  }

  const end = text.endsWith('\n') ? text.slice(0, -1) : null
  if (end !== null && (end.endsWith('\n') || end.length === 0) && !(bytes.length === 1 && bytes[0] === 10)) {
    warn(file, undefined, 'blank line(s) at end of file (git blank-at-eof)')
  }
}

/* ---------------------------------------------------------------------------- */
/* 2. Whitespace checks (git's own rules)                                     */
/* ---------------------------------------------------------------------------- */

const diffChecks = []
for (const args of [['diff', '--check'], ['diff', '--cached', '--check']]) {
  const { stdout, code } = git(args)
  if (code !== 0 && stdout.trim().length === 0) {
    // No HEAD / no index yet (fresh `git init`): not a whitespace failure.
    continue
  }
  diffChecks.push({ label: `git ${args.join(' ')}`, stdout, code })
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue
    const match = /^(.*?):(\d+): (.*)$/.exec(line)
    if (match === null) violations.push(line)
    else error(match[1], Number(match[2]), `whitespace: ${match[3]}`)
  }
}

/* ---------------------------------------------------------------------------- */

for (const entry of violations) console.error(`ERROR  ${entry}`)
for (const entry of warnings) console.warn(`warn   ${entry}`)

const whitespaceSummary = diffChecks
  .map((check) => `${check.label}=${check.code === 0 ? 'clean' : 'reported'}`)
  .join(' ')

if (violations.length > 0) {
  console.error(
    `\ncheck-encoding: ${violations.length} error(s), ${warnings.length} warning(s)`
    + ` across ${scanned} text file(s) (${skippedBinary} binary skipped) [${whitespaceSummary}].`,
  )
  console.error('These are representation defects. Fix them in the file OWNER module; this gate never edits files.')
  process.exit(1)
}

console.log(
  `check-encoding: OK - ${scanned} tracked text file(s) are valid UTF-8, no C1/mojibake/BOM-invalid damage`
  + ` (${skippedBinary} binary skipped; ${warnings.length} warning(s); ${whitespaceSummary}).`,
)
if (warnings.length > 0) {
  console.log(`check-encoding: ${warnings.length} non-blocking warning(s) listed above (UTF-8 BOM / blank-at-eof).`)
}
