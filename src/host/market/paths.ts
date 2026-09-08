/**
 * Shared path-shape validators for fields written into plugin records.
 *
 * Both the records store (fail-fast on `add`/`register` and strict load
 * validation) and the install pipeline (checkout directory names, resolved
 * plugin entries) use these single sources of truth, so a bad value is
 * rejected synchronously at the write boundary instead of surfacing later as
 * a whole-file `record/corrupt`.
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
