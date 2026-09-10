import { describe, expect, it } from 'vitest'
import {
  isManagedLocalDirName,
  parseRefSeg,
  refSegOf,
  REF_SEG_MAX_LENGTH,
  splitManagedLocalDir,
} from '../src/host/market/paths.ts'

describe('refSegOf / parseRefSeg (reversible single-segment codec)', () => {
  it('keeps simple names unchanged', () => {
    expect(refSegOf('main')).toBe('main')
    expect(refSegOf('release-1_0')).toBe('release-1_0')
    expect(refSegOf('feature_x')).toBe('feature_x')
  })

  it('escapes separators and filesystem/URL-unsafe characters', () => {
    expect(refSegOf('feature/x')).toBe('feature%2fx')
    expect(refSegOf('a\\b')).toBe('a%5cb')
    expect(refSegOf('v1.2.3')).toBe('v1%2e2%2e3')
    // The literal '.' is escaped so encoded output can never be '.' or '..'.
    expect(refSegOf('..')).toBe('%2e%2e')
    expect(refSegOf('x:y z')).toBe('x%3ay%20z')
  })

  it('round-trips names through parseRefSeg', () => {
    for (const name of ['main', 'feature/x', 'a\\b', 'v1.2.3', 'feat:deep', 'x y', '..', 'ünïcode/分支']) {
      const encoded = refSegOf(name)
      expect(encoded).not.toBeNull()
      expect(parseRefSeg(encoded as string)).toBe(name)
    }
  })

  it('is injective: distinct names never collide', () => {
    const names = ['main', 'MAIN', 'main/x', 'main%2fx', 'v1', 'v1.0', 'a-b', 'a_b']
    const seen = new Set<string>()
    for (const name of names) {
      const encoded = refSegOf(name)
      expect(encoded).not.toBeNull()
      expect(seen.has(encoded as string), `collision for ${name}`).toBe(false)
      seen.add(encoded as string)
    }
    expect(seen.size).toBe(names.length)
  })

  it('never emits a separator, backslash, dot-only segment, space or colon', () => {
    const names = ['a/b', '..', 'x\\y', 'v1.2', 'has space', 'a:b', 'feat(x)']
    for (const name of names) {
      const encoded = refSegOf(name)
      expect(encoded).not.toBeNull()
      expect(encoded).not.toMatch(/[/\\\s:.]/)
    }
  })

  it('rejects non-canonical or malformed spellings', () => {
    expect(parseRefSeg('FEATURE')).toBeNull()          // uppercase literal
    expect(parseRefSeg('feature%2FX')).toBeNull()       // uppercase hex + literal X
    expect(parseRefSeg('a%2')).toBeNull()               // truncated escape
    expect(parseRefSeg('a%zz')).toBeNull()              // non-hex escape
    expect(parseRefSeg('main.')).toBeNull()             // literal dot is never canonical
    expect(parseRefSeg('')).toBeNull()
    expect(parseRefSeg('%2e%2e')).toBe('..')            // canonical spelling parses
  })

  it('bounds the encoded length', () => {
    const long = 'x'.repeat(REF_SEG_MAX_LENGTH + 10)
    expect(refSegOf(long)).toBeNull()
  })
})

describe('isManagedLocalDirName / splitManagedLocalDir (v2 checkout layout)', () => {
  it('accepts a legacy single segment and the v2 ref path', () => {
    expect(isManagedLocalDirName('gh-owner-repo')).toBe(true)
    expect(isManagedLocalDirName('owner/repo/branch/main')).toBe(true)
    expect(isManagedLocalDirName('owner/repo/tag/v1%2e0%2e0')).toBe(true)
  })

  it('splits a v2 path into owner/repo/kind/refSeg', () => {
    expect(splitManagedLocalDir('owner/repo/branch/main')).toEqual({
      owner: 'owner', repo: 'repo', kind: 'branch', refSeg: 'main',
    })
    expect(splitManagedLocalDir('owner/repo/tag/v1%2e0%2e0')?.kind).toBe('tag')
    expect(splitManagedLocalDir('gh-owner-repo')).toBeNull()
  })

  it('rejects wrong segment counts, separators and traversal', () => {
    for (const bad of [
      'a/b',                            // 2 segments only
      'a/b/c',                          // 3 segments only
      'owner/repo/branch/main/x',       // 5 segments
      'owner/../evil/branch/main',      // escaping ..
      '../owner/repo/branch/main',      // leading ..
      'owner/repo/other/main',          // non-branch/tag kind segment
      'owner/repo/branch/a%2',          // malformed refSeg
      'owner\\repo\\branch\\main',      // backslash separators
      '/owner/repo/branch/main',        // absolute
      'owner/repo/branch/',             // empty refSeg
    ]) {
      expect(isManagedLocalDirName(bad), bad).toBe(false)
      expect(splitManagedLocalDir(bad), bad).toBeNull()
    }
  })
})


