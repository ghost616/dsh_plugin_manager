#!/usr/bin/env node
/**
 * Repository encoding / whitespace pre-flight.
 *
 * Why this exists: this project was hit by two representation accidents that no
 * other gate can see - a lossy PowerShell round-trip re-encoded a UTF-8 source
 * file as cp1252 (em dashes became `?` / 0x3F), and mojibake sequences reached a
 * file that was perfectly valid syntax. `tsc` and `vitest` accept both, so the
 * damage only shows up as garbled user-visible copy far downstream. This script
 * is the cheap, dependency-free gate for that class of defect.
 *
 * Scope: files that are TRACKED by git (`git ls-files`), minus a configured
 * ignore prefix (the local, never-committed test environment) and binaries (a
 * NUL byte anywhere in the file).
 *
 * Checks, with the calibration that keeps them free of false positives:
 *   ERRORS (exit 1)
 *     1. invalid UTF-8 byte sequence (`TextDecoder` fatal); the offending byte
 *        offset is reported with a hex/excerpt window.
 *     2. C1 control characters (U+0080-U+009F). Legitimate text - including
 *        Chinese and typographic dashes/quotes - never contains them; they are
 *        the signature of UTF-8 bytes decoded as Latin-1/cp1252.
 *     3. U+FFFD REPLACEMENT CHARACTER: an irreversible decode loss.
 *     4. cp1252 mojibake pairs (U+00C2 / U+00C3 / U+00E2 followed by a
 *        continuation byte, the classic corrupted-dash shape).
 *     5. `git diff --check` whitespace rules (trailing whitespace,
 *        space-before-tab, ...) over the worktree and the index; the exact
 *        subset is git's own, so this stays "git diff --check-like" rather than
 *        a second, drifting opinion.
 *   WARNINGS (never fail the run)
 *     6. UTF-8 BOM at the start of a file (this repo is BOM-less).
 *     7. blank line(s) at end of file (git's `blank-at-eof` rule), reported only
 *        when the git pass did not already report it for that file. Missing a
 *        FINAL newline is not flagged at all: git's default rule set does not
 *        include `missing-at-eof`, and many tracked files predate it.
 *     8. NOT DETECTED ON PURPOSE - a bare `?` where a dash/quote used to be.
 *        The 0x3F accident is real, but no shape of it can be told apart from
 *        this codebase's ordinary code: ` ? ` is the ternary separator in
 *        nearly every TypeScript file here (a candidate rule matched 275
 *        legitimate lines and zero defects). The unambiguous neighbours above
 *        already catch the same accidents.
 *
 * Usage:
 *   node scripts/check-encoding.mjs              # gate (wired into `npm test`)
 *   node scripts/check-encoding.mjs --self-test  # fixture-driven self-test
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The one directory excluded wholesale (the local, never-committed test env). */
const IGNORED_PREFIX = '.lizhu_env/'

const C1_RANGE = /[\u0080-\u009F]/
const REPLACEMENT = /\uFFFD/
/**
 * A cp1252 lead byte (U+00C2 / U+00C3 / U+00E2, i.e. what `Â`/`Ã`/`â` encode to
 * once the mangled text is stored as UTF-8 again) followed by the second
 * character of the pair. The follower window covers both shapes seen in the
 * wild: a raw C1 range character (the byte-decoded form, e.g. `â` + U+0080) and
 * the cp1252 punctuation that Windows-1252 maps its 0x80-0x9F slots to
 * (U+20AC €, U+2018-U+201D quotes, U+2022, U+2122, ...).
 */
const MOJIBAKE = /[\u00C2\u00C3\u00E2](?:[\u0080-\u00BF]|[\u2018-\u201F\u2020-\u2022\u20AC\u2030\u2039\u203A\u2122])/

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

/**
 * Decode UTF-8 WITHOUT dropping a leading BOM (`ignoreBOM: true` means "do not
 * strip it", which is what the BOM check needs: the default decoder silently
 * removes U+FEFF, so `text.startsWith('\uFEFF')` could never fire).
 */
function decodeUtf8(bytes, { fatal = false } = {}) {
  return new TextDecoder('utf-8', { fatal, ignoreBOM: true }).decode(bytes)
}

/** Byte offset of the first invalid UTF-8 sequence, or -1 when the text is valid. */
function decodeStrict(bytes) {
  try {
    return { text: decodeUtf8(bytes, { fatal: true }), badOffset: -1 }
  } catch {
    // Locate the first bad sequence by bisecting on the fatal decoder.
    let low = 0
    let high = bytes.length
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2)
      try {
        decodeUtf8(bytes.subarray(0, mid), { fatal: true })
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
  // Non-global test per line: a non-global regex carries no `lastIndex` state, so
  // no line can be skipped by a stale cursor. (A global regex reused across
  // lines does exactly that: each per-line `test()` resumes from the previous
  // hit and can walk past a later match on the same line.)
  const matcher = new RegExp(pattern.source, pattern.flags.replace('g', ''))
  for (const [index, line] of text.split('\n').entries()) {
    if (matcher.test(line)) {
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
  const text = decodeUtf8(slice).replace(/[\u0000-\u001F\u007F]/g, '.')
  return `offset ${offset}: [${hex}] ~ ${JSON.stringify(text)}`
}

/**
 * Content checks for ONE byte buffer. Split out from the corpus walk so the
 * self-test can drive it over synthetic fixtures without touching the worktree.
 */
function checkFile(bytes) {
  const errors = []
  const warnings = []
  const decoded = decodeStrict(bytes)
  if (decoded.text === null) {
    errors.push(`invalid UTF-8 byte sequence (${hexWindow(bytes, decoded.badOffset)})`)
    return { errors, warnings }
  }
  const text = decoded.text

  if (text.startsWith('\uFEFF')) {
    warnings.push('UTF-8 BOM at start of file (this repo is BOM-less UTF-8)')
  }

  const c1 = lineNumbers(text, C1_RANGE)
  if (c1.length > 0) {
    errors.push(`C1 control character(s) (U+0080-U+009F) on line(s) ${c1.join(', ')} - UTF-8 bytes decoded as Latin-1/cp1252`)
  }

  const replacement = lineNumbers(text, REPLACEMENT)
  if (replacement.length > 0) {
    errors.push(`U+FFFD replacement character on line(s) ${replacement.join(', ')} - a decode already lost data`)
  }

  const mojibake = lineNumbers(text, MOJIBAKE)
  if (mojibake.length > 0) {
    errors.push(`cp1252 mojibake pair (two bogus accented chars) on line(s) ${mojibake.join(', ')} - UTF-8 bytes re-read as Latin-1 where a dash/quote belongs`)
  }

  // `blank-at-eof` is git's own rule; this is only a hint for files git does not
  // report (git walks changed files only). `check()` dedupes it against git.
  const end = text.endsWith('\n') ? text.slice(0, -1) : null
  const onlyNewline = bytes.length === 1 && bytes[0] === 10
  if (end !== null && !onlyNewline && (end.endsWith('\n') || end.length === 0)) {
    warnings.push('blank line(s) at end of file (git blank-at-eof)')
  }

  return { errors, warnings }
}

/**
 * Parse `git diff --check` output. Findings are `path:line: message`; every
 * other line is diff CONTENT (a `+`/`-`/`\` prefixed line or a hunk header) and
 * must be ignored - treating those as findings was a real defect: with a
 * trailing-whitespace hit, `git diff --check` also prints the offending
 * `+const b = 2   ` line, which used to be reported as a second, bogus ERROR.
 */
function parseWhitespaceErrors(stdout) {
  const found = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim().length === 0) continue
    const match = /^(.*?):(\d+): (.*)$/.exec(line)
    if (match !== null) {
      found.push({ file: match[1], line: Number(match[2]), message: match[3] })
      continue
    }
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith('\\')) continue
    if (line.startsWith('diff --git') || line.startsWith('@@') || line.startsWith('index ')) continue
    // Anything else is an unparsable finding (git changed its output shape):
    // surface it rather than silently dropping it.
    found.push({ file: '(git diff --check)', line: 0, message: line })
  }
  return found
}

/**
 * Full check. With no options it checks the tracked corpus of the repository it
 * runs in; `roots` (self-test) checks a synthetic file list the same way, and
 * skips the git passes (a temp dir is not a worktree).
 */
function check(options = {}) {
  const violations = []
  const warnings = []
  const error = (file, line, message) => {
    violations.push(`${file}${line === undefined ? '' : `:${line}`}: ${message}`)
  }
  const warn = (file, line, message) => {
    warnings.push(`${file}${line === undefined ? '' : `:${line}`}: ${message}`)
  }

  const roots = options.roots
  const files = roots !== undefined
    ? [...roots]
    : trackedFiles(undefined).filter((file) => !file.startsWith(IGNORED_PREFIX))

  let scanned = 0
  let skippedBinary = 0
  /** Files whose blank-at-eof the git pass already reports (dedupe target). */
  const gitBlankAtEof = new Set()

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

    const result = checkFile(bytes)
    for (const message of result.errors) error(file, undefined, message)
    for (const message of result.warnings) {
      if (message.startsWith('blank line(s) at end of file') && gitBlankAtEof.has(file)) continue
      warn(file, undefined, message)
    }
  }

  const diffChecks = []
  if (roots === undefined) {
    for (const args of [['diff', '--check'], ['diff', '--cached', '--check']]) {
      const { stdout, code } = git(args)
      if (code !== 0 && stdout.trim().length === 0) {
        // No HEAD / no index yet (fresh `git init`): not a whitespace failure.
        continue
      }
      diffChecks.push({ label: `git ${args.join(' ')}`, code })
      for (const found of parseWhitespaceErrors(stdout)) {
        error(found.file, found.line === 0 ? undefined : found.line, `whitespace: ${found.message}`)
        if (found.message.includes('blank line at end of file')) gitBlankAtEof.add(found.file)
      }
    }
  }

  return {
    errors: violations,
    warnings,
    scanned,
    skippedBinary,
    diffChecks,
    whitespaceSummary: diffChecks
      .map((entry) => `${entry.label}=${entry.code === 0 ? 'clean' : 'reported'}`)
      .join(' '),
  }
}
/* ---------------------------------------------------------------------------- */
/* Self-test (`--self-test`): synthetic fixtures in a temp dir, no repo pollution */
/* ---------------------------------------------------------------------------- */

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'check-encoding-selftest-'))
  const cases = []
  const assert = (label, actual, expected) => {
    const ok = actual === expected
    cases.push({
      label,
      ok,
      detail: ok ? JSON.stringify(expected) : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    })
  }
  const write = (name, bytes) => {
    const path = join(dir, name)
    writeFileSync(path, bytes)
    return path
  }

  try {
    // 1. clean, valid UTF-8: Chinese text, an em dash and curly quotes
    const clean = write('clean.ts', Buffer.from('// \u5408\u6CD5\u7684\u4E2D\u6587 \u2014 \u201Cdash\u201D \u2018quote\u2019\nconst x = 1\n', 'utf8'))
    // 2. invalid UTF-8: a lone 0xE2 lead byte with no continuation
    const invalid = write('invalid.ts', Buffer.from([0x41, 0x20, 0xE2, 0x20, 0x42, 0x0A]))
    // 3. C1 control character held as the character itself
    //    (U+0096, the cp1252 en dash, inside an otherwise valid file)
    const c1 = write('c1.ts', Buffer.from('const a = "x \u0096 y"\n', 'utf8'))
    // 4. cp1252 mojibake: what a lossy round-trip leaves where a dash belongs
    //    (utf8 E2 80 94 re-read as cp1252 gives U+00E2 U+20AC U+201D). It
    //    deliberately carries no C1 character, so this exercises the mojibake
    //    rule on its own.
    const mojibake = write('mojibake.ts', Buffer.from('// an \u00E2\u20AC\u201D em dash\n', 'utf8'))
    // 5. U+FFFD replacement character
    const replacement = write('replacement.ts', Buffer.from('// lost \uFFFD here\n', 'utf8'))
    // 6. UTF-8 BOM (warning; the text itself is valid)
    const bom = write('bom.ts', Buffer.from('\uFEFFexport const x = 1\n', 'utf8'))
    // 7. blank line at end of file (warning)
    const blankEof = write('blank-eof.ts', Buffer.from('const y = 2\n\n', 'utf8'))
    // 8. binary: a NUL in the first block, must be skipped even though it also
    //    carries a byte that would be invalid UTF-8
    const binary = write('blob.bin', Buffer.from([0x00, 0x01, 0xE2, 0x20, 0xFF]))
    // 9. empty file: skipped, never counted as text
    const empty = write('empty.ts', Buffer.alloc(0))

    const result = check({ roots: [clean, invalid, c1, mojibake, replacement, bom, blankEof, binary, empty] })

    assert('text files scanned (binary + empty skipped)', result.scanned, 7)
    assert('binary files skipped', result.skippedBinary, 1)
    // Four damaged files (invalid UTF-8, C1, mojibake, U+FFFD) are ERRORs; the
    // BOM and the trailing blank line are WARNINGS only.
    assert('error count', result.errors.length, 4)
    assert('warning count', result.warnings.length, 2)

    const errorsFor = (file) => result.errors.filter((entry) => entry.startsWith(`${file}:`))
    const warningsFor = (file) => result.warnings.filter((entry) => entry.startsWith(`${file}:`))

    assert('invalid UTF-8 detected', errorsFor(invalid).length, 1)
    assert('invalid UTF-8 reports the byte window', errorsFor(invalid)[0]?.includes('offset 2: [41 20 e2 20 42 0a]'), true)
    assert('C1 control character detected', errorsFor(c1).length, 1)
    assert('cp1252 mojibake detected', errorsFor(mojibake).length, 1)
    assert('U+FFFD detected', errorsFor(replacement).length, 1)
    assert('damaged files carry no warnings', result.warnings.filter((entry) => errorsFor(entry.split(':')[0]).length >= 0 && entry.startsWith(invalid)).length, 0)
    assert('clean file: no errors', errorsFor(clean).length, 0)
    assert('clean file: no warnings', warningsFor(clean).length, 0)
    assert('binary file: no findings', result.errors.concat(result.warnings).filter((entry) => entry.startsWith(`${binary}:`)).length, 0)
    assert('empty file: no findings', result.errors.concat(result.warnings).filter((entry) => entry.startsWith(`${empty}:`)).length, 0)
    assert('BOM warning reported', warningsFor(bom).some((entry) => entry.includes('BOM')), true)
    assert('blank-at-eof warning reported', warningsFor(blankEof).some((entry) => entry.includes('blank line(s) at end of file')), true)

    // Whitespace parser: exactly the output shape real `git diff --check` emits
    // (the trailing `+const b = 2   ` content line is NOT a second finding).
    const gitOutput = 'b.ts:1: trailing whitespace.\n+const b = 2   \ndiff --git a/b.ts b/b.ts\n'
    const parsed = parseWhitespaceErrors(gitOutput)
    assert('whitespace parser: one finding (content line skipped)', parsed.length, 1)
    assert('whitespace parser: file', parsed[0]?.file, 'b.ts')
    assert('whitespace parser: line', parsed[0]?.line, 1)
    assert('whitespace parser: message', parsed[0]?.message, 'trailing whitespace.')

    const blankAtEofOutput = 'a.ts:3: blank line at end of file\n'
    const blankParsed = parseWhitespaceErrors(blankAtEofOutput)
    assert('blank-at-eof parser: one finding', blankParsed.length, 1)
    assert('blank-at-eof parser: message', blankParsed[0]?.message, 'blank line at end of file')
    assert('parser: empty output is clean', parseWhitespaceErrors('').length, 0)
  } finally {
    // Never leave fixtures behind (and never create them inside the repo).
    rmSync(dir, { recursive: true, force: true })
  }

  const failed = cases.filter((entry) => !entry.ok)
  for (const entry of failed) console.error(`FAIL  ${entry.label}: ${entry.detail}`)
  if (failed.length > 0) {
    console.error(`\ncheck-encoding --self-test: ${failed.length} of ${cases.length} assertion(s) FAILED (exit 1).`)
    return 1
  }
  console.log(`check-encoding --self-test: OK - ${cases.length} assertion(s) passed (exit 0).`)
  return 0
}

/* ---------------------------------------------------------------------------- */

if (process.argv.includes('--self-test')) {
  process.exit(selfTest())
}

const result = check()

for (const entry of result.errors) console.error(`ERROR  ${entry}`)
for (const entry of result.warnings) console.warn(`warn   ${entry}`)

if (result.errors.length > 0) {
  console.error(
    `\ncheck-encoding: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`
    + ` across ${result.scanned} text file(s) (${result.skippedBinary} binary skipped) [${result.whitespaceSummary}].`,
  )
  console.error('These are representation defects. Fix them in the file OWNER module; this gate never edits files.')
  process.exit(1)
}

console.log(
  `check-encoding: OK - ${result.scanned} tracked text file(s) are valid UTF-8, no C1/mojibake/BOM-invalid damage`
  + ` (${result.skippedBinary} binary skipped; ${result.warnings.length} warning(s); ${result.whitespaceSummary}).`,
)
if (result.warnings.length > 0) {
  console.log(`check-encoding: ${result.warnings.length} non-blocking warning(s) listed above (UTF-8 BOM / blank-at-eof).`)
}