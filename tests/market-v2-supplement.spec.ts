import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MarketError } from '../src/host/market/errors.ts'
import { PluginInstaller, type CommandOutcome, type CommandRunner } from '../src/host/market/install.ts'
import { isValidPluginKey, PLUGIN_MARKET_KEY_MAX_LENGTH, pluginKeyForGithubRef } from '../src/host/market/keys.ts'
import { parseRefSeg, refSegOf, REF_SEG_MAX_LENGTH } from '../src/host/market/paths.ts'
import { makeSuiteTmp, removeTmp } from './support/tmpdir.ts'

function expectKeyInvalid(fn: () => void): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    expect((error as MarketError).code).toBe('record/key-invalid')
    return
  }
  throw new Error('expected MarketError with code record/key-invalid, but the call resolved')
}

describe('pluginKeyForGithubRef edge cases', () => {
  it('keeps the digest fallback deterministic and bounded across calls', () => {
    const longOwner = 'o'.repeat(40)
    const longRepo = 'r'.repeat(60)
    const first = pluginKeyForGithubRef(`${longOwner}/${longRepo}`, 'branch', 'main')
    const second = pluginKeyForGithubRef(`${longOwner}/${longRepo}`, 'branch', 'main')
    expect(first).toBe(second)
    expect(isValidPluginKey(first)).toBe(true)
    expect(first.length).toBeLessThanOrEqual(PLUGIN_MARKET_KEY_MAX_LENGTH)
    expect(first.startsWith('gh')).toBe(true)
  })

  it('rejects an empty ref with record/key-invalid', () => {
    expectKeyInvalid(() => pluginKeyForGithubRef('owner/repo', 'branch', ''))
  })

  it('rejects a ref too long to encode with record/key-invalid', () => {
    expectKeyInvalid(() => pluginKeyForGithubRef('owner/repo', 'branch', `v${'x'.repeat(REF_SEG_MAX_LENGTH)}`))
  })
})

describe('refSegOf / parseRefSeg byte-level behavior', () => {
  // Inputs written with \u escapes (pure ASCII source): u+00FC=u-umlaut,
  // u+00EF=i-umlaut, u+5206/u+652F = CJK chars fen/zhi.
  it('escapes non-ASCII UTF-8 bytes with lowercase hex (2-byte and 3-byte)', () => {
    expect(refSegOf('\u00fcn\u00efcode')).toBe('%c3%bcn%c3%afcode')
    expect(refSegOf('\u5206\u652f')).toBe('%e5%88%86%e6%94%af')
    expect(parseRefSeg('%e5%88%86%e6%94%af')).toBe('\u5206\u652f')
  })

  it('returns null for an empty name and for an over-long segment', () => {
    expect(refSegOf('')).toBeNull()
    expect(parseRefSeg('x'.repeat(REF_SEG_MAX_LENGTH + 1))).toBeNull()
  })

  it('rejects escapes that decode to invalid UTF-8', () => {
    expect(parseRefSeg('%e5')).toBeNull()          // truncated 3-byte sequence
    expect(parseRefSeg('%c3%28')).toBeNull()       // 0x28 is not a continuation byte
    expect(parseRefSeg('%c0%af')).toBeNull()       // overlong encoding of '/'
  })
})

describe('v2 install git clone flags', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('v2-clone-flags') })
  afterAll(async () => { await removeTmp(tmp) })

  interface Call { command: string; args: string[] }

  function recordRunner(): { run: CommandRunner; calls: Call[] } {
    const calls: Call[] = []
    const run: CommandRunner = async (command, args) => {
      calls.push({ command, args: [...args] })
      if (command === 'git' && args[0] === 'clone') {
        const target = args[args.length - 1] ?? ''
        await mkdir(join(target, '.git'), { recursive: true })
        await writeFile(join(target, 'package.json'), JSON.stringify({ main: 'index.js' }), 'utf8')
        await writeFile(join(target, 'index.js'), 'export const value = 1\n', 'utf8')
        return { code: 0, stdout: '', stderr: '' }
      }
      const outcome: CommandOutcome = { code: 0, stdout: '', stderr: '' }
      return outcome
    }
    return { run, calls }
  }

  it('clones a v2 branch with --depth/--branch/--single-branch', async () => {
    const root = join(tmp, 'flags-branch')
    await mkdir(root)
    const slug = 'owner/sample-plugin'
    const { run, calls } = recordRunner()
    await new PluginInstaller({ run }).install({
      repositoryRoot: root,
      key: pluginKeyForGithubRef(slug, 'branch', 'main'),
      ownerRepo: slug,
      refKind: 'branch',
      ref: 'main',
      confirmed: true,
    })
    const clone = calls.find((call) => call.command === 'git' && call.args[0] === 'clone')
    expect(clone?.args).toContain('--depth')
    expect(clone?.args).toContain('--branch')
    expect(clone?.args).toContain('--single-branch')
    expect(clone?.args).toContain('main')
  })

  it('clones a v2 tag with --branch but without --single-branch', async () => {
    const root = join(tmp, 'flags-tag')
    await mkdir(root)
    const slug = 'owner/sample-plugin'
    const { run, calls } = recordRunner()
    await new PluginInstaller({ run }).install({
      repositoryRoot: root,
      key: pluginKeyForGithubRef(slug, 'tag', 'v1.2.3'),
      ownerRepo: slug,
      refKind: 'tag',
      ref: 'v1.2.3',
      confirmed: true,
    })
    const clone = calls.find((call) => call.command === 'git' && call.args[0] === 'clone')
    expect(clone?.args).toContain('--branch')
    expect(clone?.args).toContain('v1.2.3')
    expect(clone?.args).not.toContain('--single-branch')
  })
})
