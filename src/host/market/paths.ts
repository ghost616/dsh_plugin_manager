/**
 * Shared path-shape validators for fields written into plugin records.
 *
 * Both the records store (fail-fast on `add`/`register` and strict load
 * validation) and the install pipeline (checkout directories, resolved plugin
 * entries) use these single sources of truth, so a bad value is rejected
 * synchronously at the write boundary instead of surfacing later as a
 * whole-file `record/corrupt`.
 *
 * Directory conventions (v2 ref layout):
 * - legacy checkout: one path-safe segment under the repository root (e.g.
 *   `gh-owner-repo`);
 * - ref checkout: `<owner>/<repo>/<branch|tag>/<refSeg>` where `<refSeg>` is
 *   the reversible, path-safe single-segment encoding of the branch/tag name
 *   produced by {@link refSegOf}.
 */

/** Upper bound of a checkout directory-name segment. */
export const LOCAL_DIR_NAME_MAX_LENGTH = 255

/** Upper bound of a checkout-relative plugin entry path. */
export const CHECKOUT_ENTRY_MAX_LENGTH = 512

/**
 * A checkout directory name: one non-empty path segment (no separators), up
 * to {@link LOCAL_DIR_NAME_MAX_LENGTH} chars, not `.`/`..`, no NUL.
 */
export function isLocalDirSegment(value: string): boolean {
  if (value.length === 0 || value.length > LOCAL_DIR_NAME_MAX_LENGTH) return false
  if (value === '.' || value === '..') return false
  return !/[\\/\u0000]/.test(value)
}

/**
 * A plugin entry file relative to its checkout: forward-slash segments only,
 * no drive/absolute prefix, no empty, `.` or escaping (`..`) segment, no
 * backslash or NUL.
 */
export function isCheckoutEntryPath(value: string): boolean {
  if (value.length === 0 || value.length > CHECKOUT_ENTRY_MAX_LENGTH) return false
  if (/^[/\\]/.test(value) || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split('/')
  return segments.every(
    (segment) => segment.length > 0
      && segment !== '.'
      && segment !== '..'
      && !/[\\\u0000]/.test(segment),
  )
}

/**
 * Normalize a candidate entry reference read from a manifest (`main`/`exports`
 * value): strip a leading `./`, reject anything that is not a valid
 * checkout-relative entry path (returns null then).
 */
export function normalizeCheckoutEntry(value: string): string | null {
  const stripped = value.replace(/^\.\//, '')
  return isCheckoutEntryPath(stripped) ? stripped : null
}

/* ------------------------------------------------------------------------ */
/* Ref-segment codec (v2 directory convention)                              */
/* ------------------------------------------------------------------------ */

/** Upper bound (in chars) of one encoded {@link refSegOf} segment. */
export const REF_SEG_MAX_LENGTH = 200

/**
 * True for the ASCII letters/digits that stay literal in a ref segment.
 * Everything else — including `/`, `\`, `.`, `:`, control bytes, and every
 * non-ASCII UTF-8 byte — is percent-escaped, so the encoded result is a
 * single path/URL-safe segment that can never be `.`, `..` or contain a
 * separator. Lowercase/digits/`-`/`_` only ⇒ the encoding is additionally
 * case-insensitive-filesystem safe (two refs differing only by case can never
 * collide on disk).
 */
function isLiteralByte(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39)  // 0-9
    || (byte >= 0x61 && byte <= 0x7a)    // a-z
    || byte === 0x2d                     // -
    || byte === 0x5f                     // _
}

/**
 * Encode one branch/tag name into a reversible, path-safe single directory
 * segment. The mapping is injective: distinct names always produce distinct
 * segments (bytes outside the literal set are `%xx`-escaped with lowercase
 * hex, and `%` itself is escaped), so sibling checkouts of different refs can
 * never collide. Returns null when the name is empty or its encoded form
 * exceeds {@link REF_SEG_MAX_LENGTH}.
 */
export function refSegOf(name: string): string | null {
  if (name.length === 0) return null
  const bytes = utf8Bytes(name)
  let out = ''
  for (const byte of bytes) {
    if (isLiteralByte(byte)) {
      out += String.fromCharCode(byte)
    } else {
      out += `%${byte.toString(16).padStart(2, '0')}`
    }
  }
  return out.length > 0 && out.length <= REF_SEG_MAX_LENGTH ? out : null
}

/**
 * Decode one {@link refSegOf} segment back into the branch/tag name. Returns
 * null when `segment` is not a canonical encoded ref segment (wrong charset,
 * malformed `%xx`, uppercase hex, non-canonical escapes, empty or over-long).
 */
export function parseRefSeg(segment: string): string | null {
  if (segment.length === 0 || segment.length > REF_SEG_MAX_LENGTH) return null
  if (!/^[0-9a-z_%-]+$/.test(segment)) return null
  const bytes: number[] = []
  for (let index = 0; index < segment.length;) {
    const char = segment[index]
    if (char === '%') {
      const hex = segment.slice(index + 1, index + 3)
      if (!/^[0-9a-f]{2}$/.test(hex)) return null
      bytes.push(Number.parseInt(hex, 16))
      index += 3
    } else {
      if (char === undefined) return null
      const code = char.charCodeAt(0)
      if (!isLiteralByte(code)) return null
      bytes.push(code)
      index += 1
    }
  }
  if (bytes.length === 0) return null
  const decoded = utf8Decode(bytes)
  // Canonical-form check: a decodable but non-canonical spelling (uppercase
  // hex, an unnecessarily escaped literal) is rejected so every stored
  // segment equals exactly one name.
  return decoded !== null && refSegOf(decoded) === segment ? decoded : null
}

/** Encode a JS string into its UTF-8 bytes (no global TextEncoder dependency). */
function utf8Bytes(value: string): number[] {
  const bytes: number[] = []
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x7f) {
      bytes.push(code)
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code <= 0xffff) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return bytes
}

/** Decode UTF-8 bytes back into a JS string (null on invalid sequences). */
function utf8Decode(bytes: readonly number[]): string | null {
  const out: string[] = []
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]
    if (first === undefined) return null
    let code: number
    let width: number
    if (first <= 0x7f) {
      code = first
      width = 1
    } else if (first >= 0xc2 && first <= 0xdf) {
      code = first & 0x1f
      width = 2
    } else if (first >= 0xe0 && first <= 0xef) {
      code = first & 0x0f
      width = 3
    } else if (first >= 0xf0 && first <= 0xf4) {
      code = first & 0x07
      width = 4
    } else {
      return null
    }
    for (let step = 1; step < width; step += 1) {
      const next = bytes[index + step]
      if (next === undefined || (next & 0xc0) !== 0x80) return null
      code = (code << 6) | (next & 0x3f)
    }
    if (code > 0x10ffff) return null
    if (width === 3 && code < 0x800) return null      // overlong
    if (width === 4 && code < 0x10000) return null    // overlong
    if (code >= 0xd800 && code <= 0xdfff) return null // surrogate
    out.push(String.fromCodePoint(code))
    index += width
  }
  return out.join('')
}

/* ------------------------------------------------------------------------ */
/* Checkout local-dir names (legacy single segment + v2 ref layout)         */
/* ------------------------------------------------------------------------ */

/**
 * A checkout `localDirName` relative to the repository root, forward-slash
 * separated. Accepts both:
 * - legacy single segment (`isLocalDirSegment`), and
 * - the v2 ref layout `<owner>/<repo>/<branch|tag>/<refSeg>` whose fourth
 *   segment is a canonical {@link refSegOf} encoding and whose first two
 *   segments are path-safe (owner/repo slug halves may contain dots/dashes).
 *
 * Other segment counts (including a bare `a/b`) are rejected: they match
 * neither a legacy checkout nor the fixed ref layout.
 */
export function isManagedLocalDirName(value: string): boolean {
  if (isLocalDirSegment(value)) return true
  const segments = value.split('/')
  if (segments.length !== 4) return false
  const [owner, repo, kind, refSeg] = segments
  if (owner === undefined || repo === undefined || kind === undefined || refSeg === undefined) return false
  if (!isLocalDirSegment(owner) || !isLocalDirSegment(repo)) return false
  if (kind !== 'branch' && kind !== 'tag') return false
  return parseRefSeg(refSeg) !== null
}

/** Split a v2 ref-layout localDirName into its owner/repo/kind/refSeg; null otherwise. */
export function splitManagedLocalDir(value: string): {
  readonly owner: string
  readonly repo: string
  readonly kind: 'branch' | 'tag'
  readonly refSeg: string
} | null {
  const segments = value.split('/')
  if (segments.length !== 4) return null
  const [owner, repo, kind, refSeg] = segments
  if (owner === undefined || repo === undefined || refSeg === undefined) return null
  if (kind !== 'branch' && kind !== 'tag') return null
  if (!isLocalDirSegment(owner) || !isLocalDirSegment(repo)) return null
  if (parseRefSeg(refSeg) === null) return null
  return { owner, repo, kind, refSeg }
}
