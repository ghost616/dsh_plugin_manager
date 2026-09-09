import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ANALYZE_SYSTEM_PROMPT,
  ANALYSIS_OUTPUT_MAX_LENGTH,
  ANALYSIS_REASON_MAX_LENGTH,
  DEFAULT_CHECKOUT_ENTRY,
  InstallAnalyzer,
  SNAPSHOT_EXCLUDED_TOP_LEVEL,
  buildAnalyzePrompt,
  collectCheckoutSnapshot,
  parseAnalysisOutput,
  resolveAnalysisVerdict,
  type CheckoutSnapshot,
  type LlmCompletion,
  type RawCheckoutAnalysis,
} from '../src/host/market/index.ts'
import { NodeFs } from '../src/host/market/fs.ts'
import { MarketError } from '../src/host/market/errors.ts'
import { makeSuiteTmp, removeTmp } from './support/tmpdir.ts'

/** Assert that `fn` throws a MarketError with the given stable code. */
function expectMarketError(fn: () => unknown, code: string): MarketError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    const market = error as MarketError
    expect(market.code).toBe(code)
    return market
  }
  throw new Error(`expected MarketError with code ${code}, but nothing was thrown`)
}

/** Assert that an async `fn` rejects with a MarketError of the given code. */
async function expectAsyncMarketError(fn: () => Promise<unknown>, code: string): Promise<MarketError> {
  try {
    await fn()
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    const market = error as MarketError
    expect(market.code).toBe(code)
    return market
  }
  throw new Error(`expected MarketError with code ${code}, but nothing was rejected`)
}

function rawOf(overrides: Partial<RawCheckoutAnalysis> = {}): RawCheckoutAnalysis {
  return { kind: 'plugin', reason: 'A Cordis/dsh plugin', entryHint: null, ...overrides }
}

function pluginJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: 'plugin', reason: 'A Cordis/dsh plugin', entryHint: 'index.js', ...overrides })
}

const manifest = {
  name: 'sample-plugin',
  version: '1.0.0',
  description: 'An example plugin',
  main: 'lib/index.js',
  hasBuildScript: true,
}

function snapshotOf(overrides: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot {
  return {
    readme: '# sample plugin\n\nA README describing the plugin.',
    entries: [
      { name: 'README.md', directory: false },
      { name: 'lib', directory: true },
      { name: 'package.json', directory: false },
      { name: 'src', directory: true },
    ],
    topLevelCount: 4,
    manifest,
    ...overrides,
  }
}

const validText = pluginJson()

describe('collectCheckoutSnapshot', () => {
  let root: string

  beforeAll(async () => {
    root = await makeSuiteTmp('analyze-snapshot')
  })

  afterAll(async () => {
    await removeTmp(root)
  })

  it('picks the first existing README candidate by order (README before README.md)', async () => {
    const dir = join(root, 'candidates')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'README'), 'extensionless readme')
    await writeFile(join(dir, 'README.md'), 'markdown readme')
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'p' }))
    const snapshot = await collectCheckoutSnapshot(dir)
    expect(snapshot.readme).toBe('extensionless readme')
  })

  it('falls through to README.md when only it exists', async () => {
    const dir = join(root, 'only-md')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'README.md'), 'only markdown readme')
    const snapshot = await collectCheckoutSnapshot(dir, { fs: NodeFs })
    expect(snapshot.readme).toBe('only markdown readme')
  })

  it('returns a null readme when no README candidate exists', async () => {
    const dir = join(root, 'no-readme')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}')
    const snapshot = await collectCheckoutSnapshot(dir)
    expect(snapshot.readme).toBeNull()
  })

  it('excludes node_modules/.git and caps the sorted listing, keeping the total count', async () => {
    const dir = join(root, 'listing')
    await mkdir(dir, { recursive: true })
    const files = ['README', 'README.md', 'b.txt', 'index.js', 'package.json', 'zz.txt']
    const dirs = ['src', 'node_modules', '.git']
    for (const name of files) await writeFile(join(dir, name), 'x')
    for (const name of dirs) await mkdir(join(dir, name))
    const snapshot = await collectCheckoutSnapshot(dir, { entryLimit: 3 })
    expect(snapshot.entries.map((entry) => entry.name)).toEqual(['README', 'README.md', 'b.txt'])
    expect(snapshot.topLevelCount).toBe(7)
    expect(snapshot.readme).toBe('x')
  })

  it('summarizes package.json including the build-script flag', async () => {
    const dir = join(root, 'manifest')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'sample-plugin',
      version: '1.0.0',
      description: 'An example plugin',
      main: 'lib/index.js',
      scripts: { build: 'tsdown' },
    }))
    const snapshot = await collectCheckoutSnapshot(dir)
    expect(snapshot.manifest).toEqual({
      name: 'sample-plugin',
      version: '1.0.0',
      description: 'An example plugin',
      main: 'lib/index.js',
      hasBuildScript: true,
    })
  })

  it('returns a null manifest when package.json is absent or unparsable', async () => {
    const none = join(root, 'no-manifest')
    await mkdir(none, { recursive: true })
    expect((await collectCheckoutSnapshot(none)).manifest).toBeNull()

    const broken = join(root, 'broken-manifest')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'package.json'), 'not json')
    expect((await collectCheckoutSnapshot(broken)).manifest).toBeNull()
  })

  it('marks directories and files correctly in the listing', async () => {
    const dir = join(root, 'kinds')
    await mkdir(dir, { recursive: true })
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'index.js'), 'export default {}')
    const snapshot = await collectCheckoutSnapshot(dir)
    expect(snapshot.entries).toContainEqual({ name: 'src', directory: true })
    expect(snapshot.entries).toContainEqual({ name: 'index.js', directory: false })
  })
})

describe('buildAnalyzePrompt', () => {
  it('embeds the README text, the listing and the package.json summary', () => {
    const prompt = buildAnalyzePrompt(snapshotOf())
    expect(prompt.system).toBe(ANALYZE_SYSTEM_PROMPT)
    expect(prompt.system).toContain('EXACTLY ONE JSON object')
    expect(prompt.system).toContain('no Markdown code fences')
    const user = prompt.user
    expect(user).toContain('# sample plugin')
    expect(user).toContain('- package.json')
    expect(user).toContain('- lib/')
    expect(user).toContain('name: sample-plugin')
    expect(user).toContain('main: lib/index.js')
    expect(user).toContain('build script: yes')
    expect(user).toContain('node_modules')
  })

  it('marks a long README as truncated in the prompt', () => {
    const readme = `# head\n\n${'x'.repeat(7000)}`
    const prompt = buildAnalyzePrompt(snapshotOf({ readme }))
    expect(prompt.user).toContain('[README truncated]')
    expect(prompt.user).not.toContain('x'.repeat(6500))
  })

  it('renders the no-readme and no-manifest placeholders', () => {
    const prompt = buildAnalyzePrompt(snapshotOf({ readme: null, manifest: null }))
    expect(prompt.user).toContain('(no README found)')
    expect(prompt.user).toContain('(absent or unreadable)')
  })
})

describe('parseAnalysisOutput', () => {
  it('parses a plain valid JSON object and normalizes entryHint', () => {
    const raw = parseAnalysisOutput(pluginJson({ entryHint: './lib/index.js', reason: '  A plugin  ' }))
    expect(raw).toEqual({ kind: 'plugin', reason: 'A plugin', entryHint: 'lib/index.js' })
  })

  it('accepts a Markdown-fenced JSON answer (with and without a language tag)', () => {
    for (const text of [
      `\`\`\`json\n${validText}\n\`\`\``,
      `\`\`\`\n${validText}\n\`\`\``,
    ]) {
      expect(parseAnalysisOutput(text).kind).toBe('plugin')
    }
  })

  it('rejects prose around the JSON and plain garbage', () => {
    for (const text of [
      `Here you go:\n${validText}`,
      'not json at all',
      `${validText} trailing`,
    ]) {
      expectMarketError(() => parseAnalysisOutput(text), 'market/llm-bad-output')
    }
  })

  it('rejects a non-string completion result', () => {
    expectMarketError(() => parseAnalysisOutput(42), 'market/llm-bad-output')
    expectMarketError(() => parseAnalysisOutput(null), 'market/llm-bad-output')
  })

  it('rejects a whole output beyond the length cap', () => {
    const text = `${' '.repeat(ANALYSIS_OUTPUT_MAX_LENGTH + 1)}{"kind":"plugin","reason":"x"}`
    expectMarketError(() => parseAnalysisOutput(text), 'market/llm-bad-output')
  })

  it('rejects JSON that is not a single object', () => {
    for (const text of ['[1,2]', 'null', '42', '"plugin"']) {
      expectMarketError(() => parseAnalysisOutput(text), 'market/llm-bad-output')
    }
  })

  it('rejects a missing/unknown kind field', () => {
    expectMarketError(() => parseAnalysisOutput('{"reason":"x"}'), 'market/llm-bad-output')
    expectMarketError(() => parseAnalysisOutput(JSON.stringify({ kind: 'dsh-plugin', reason: 'x' })), 'market/llm-bad-output')
    expectMarketError(() => parseAnalysisOutput(JSON.stringify({ kind: 5, reason: 'x' })), 'market/llm-bad-output')
  })

  it('rejects a missing, empty or non-string reason', () => {
    expectMarketError(() => parseAnalysisOutput(JSON.stringify({ kind: 'plugin' })), 'market/llm-bad-output')
    expectMarketError(() => parseAnalysisOutput(JSON.stringify({ kind: 'plugin', reason: '   ' })), 'market/llm-bad-output')
    expectMarketError(() => parseAnalysisOutput(JSON.stringify({ kind: 'plugin', reason: 42 })), 'market/llm-bad-output')
  })

  it('rejects an over-long reason and accepts one exactly at the cap', () => {
    expectMarketError(
      () => parseAnalysisOutput(JSON.stringify({ kind: 'plugin', reason: 'x'.repeat(ANALYSIS_REASON_MAX_LENGTH + 1) })),
      'market/llm-bad-output',
    )
    const raw = parseAnalysisOutput(JSON.stringify({ kind: 'plugin', reason: 'x'.repeat(ANALYSIS_REASON_MAX_LENGTH) }))
    expect(raw.reason.length).toBe(ANALYSIS_REASON_MAX_LENGTH)
  })

  it('rejects a malformed entryHint and accepts null/blank/missing', () => {
    expectMarketError(() => parseAnalysisOutput(JSON.stringify({ kind: 'plugin', reason: 'x', entryHint: 7 })), 'market/llm-bad-output')
    expectMarketError(() => parseAnalysisOutput(JSON.stringify({ kind: 'plugin', reason: 'x', entryHint: '../escape' })), 'market/llm-bad-output')
    expectMarketError(() => parseAnalysisOutput(JSON.stringify({ kind: 'plugin', reason: 'x', entryHint: '/abs/index.js' })), 'market/llm-bad-output')
    for (const text of [
      pluginJson({ entryHint: null }),
      pluginJson({ entryHint: '' }),
      pluginJson({ entryHint: '   ' }),
      pluginJson({ entryHint: undefined }), // JSON.stringify omits the field: the missing case
    ]) {
      expect(parseAnalysisOutput(text).entryHint).toBeNull()
    }
  })
})

describe('resolveAnalysisVerdict', () => {
  it('returns a plugin verdict from an entryHint with entryPresent unknown/default', () => {
    const raw = rawOf({ entryHint: 'lib/index.js' })
    expect(resolveAnalysisVerdict(raw)).toEqual({
      verdict: 'plugin',
      entry: 'lib/index.js',
      entryHint: 'lib/index.js',
      reason: 'A Cordis/dsh plugin',
    })
  })

  it('falls back to the conventional entry when no entryHint was given', () => {
    const verdict = resolveAnalysisVerdict(rawOf({ entryHint: null }))
    expect(verdict.entry).toBe(DEFAULT_CHECKOUT_ENTRY)
    expect(verdict.entryHint).toBeNull()
  })

  it('rejects a plugin whose entry file is not present as market/unsupported-build', () => {
    const error = expectMarketError(
      () => resolveAnalysisVerdict(rawOf({ entryHint: 'lib/index.js', reason: 'needs pnpm build' }), { entryPresent: false }),
      'market/unsupported-build',
    )
    expect(error.message).toContain('"lib/index.js"')
    expect(error.message).toContain('build it first')
    expect(error.message).toContain('needs pnpm build')
  })

  it('accepts a plugin whose entry file is present', () => {
    const verdict = resolveAnalysisVerdict(rawOf({ entryHint: 'lib/index.js' }), { entryPresent: true })
    expect(verdict.verdict).toBe('plugin')
    expect(verdict.entry).toBe('lib/index.js')
  })

  it('maps skills/preset/tooling/other to their stable rejection codes', () => {
    const expectations: Array<[RawCheckoutAnalysis, string]> = [
      [rawOf({ kind: 'skills', reason: 'A Claude skills collection' }), 'market/unsupported-skills'],
      [rawOf({ kind: 'preset', reason: 'An include-tree preset' }), 'market/unsupported-preset'],
      [rawOf({ kind: 'tooling', reason: 'A CLI utility' }), 'market/unsupported-other'],
      [rawOf({ kind: 'other', reason: 'Just documentation' }), 'market/unsupported-other'],
    ]
    for (const [raw, code] of expectations) {
      const error = expectMarketError(() => resolveAnalysisVerdict(raw), code)
      expect(error.message).toContain(raw.reason)
    }
  })
})

describe('InstallAnalyzer', () => {
  it('analyzes a checkout through the injected completion and forwards provider/model', async () => {
    const complete = vi.fn<LlmCompletion>(async (request) => {
      expect(request.provider).toBe('ds-provider')
      expect(request.model).toBe('deepseek-chat')
      expect(request.system).toContain('JSON object')
      expect(request.user).toContain('name: sample-plugin')
      expect(request.user).toContain('# sample plugin')
      return validText
    })
    const analyzer = new InstallAnalyzer({ complete, provider: 'ds-provider', model: 'deepseek-chat' })
    const verdict = await analyzer.analyze(snapshotOf())
    expect(verdict).toEqual({
      verdict: 'plugin',
      entry: 'index.js',
      entryHint: 'index.js',
      reason: 'A Cordis/dsh plugin',
    })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('rejects plugin checkouts whose entry is absent via the hasFile probe', async () => {
    const complete = vi.fn<LlmCompletion>(async () => pluginJson({ entryHint: 'lib/index.js', reason: 'TypeScript source; build first' }))
    const hasFile = vi.fn(async () => false)
    const analyzer = new InstallAnalyzer({ complete, provider: 'ds-provider', model: 'deepseek-chat', hasFile })
    const error = await expectAsyncMarketError(() => analyzer.analyze(snapshotOf()), 'market/unsupported-build')
    expect(hasFile).toHaveBeenCalledWith('lib/index.js')
    expect(error.message).toContain('build it first')
  })

  it('does not call the completion without a configured provider/model', async () => {
    const complete = vi.fn<LlmCompletion>(async () => validText)
    const analyzer = new InstallAnalyzer({ complete })
    await expectAsyncMarketError(() => analyzer.analyze(snapshotOf()), 'market/llm-unconfigured')
    expect(complete).not.toHaveBeenCalled()
  })

  it('normalizes a completion transport failure to market/llm-failed', async () => {
    const complete = vi.fn<LlmCompletion>(async () => {
      throw new Error('network exploded')
    })
    const analyzer = new InstallAnalyzer({ complete, provider: 'ds-provider', model: 'deepseek-chat' })
    const error = await expectAsyncMarketError(() => analyzer.analyze(snapshotOf()), 'market/llm-failed')
    expect(error.message).toContain('network exploded')
  })

  it('passes an already-stable MarketError from the completion through unchanged', async () => {
    const original = new MarketError('market/llm-failed', 'finish error from the real backend')
    const complete = vi.fn<LlmCompletion>(async () => {
      throw original
    })
    const analyzer = new InstallAnalyzer({ complete, provider: 'ds-provider', model: 'deepseek-chat' })
    await expectAsyncMarketError(() => analyzer.analyze(snapshotOf()), 'market/llm-failed')
  })

  it('surfaces market/llm-bad-output for an unparsable completion result', async () => {
    const complete = vi.fn<LlmCompletion>(async () => 'garbage output')
    const analyzer = new InstallAnalyzer({ complete, provider: 'ds-provider', model: 'deepseek-chat' })
    await expectAsyncMarketError(() => analyzer.analyze(snapshotOf()), 'market/llm-bad-output')
  })

  it('rejects non-plugin kinds end to end with their stable codes', async () => {
    const expectations: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'skills', reason: 'a skills pack' }, 'market/unsupported-skills'],
      [{ kind: 'preset', reason: 'a preset' }, 'market/unsupported-preset'],
      [{ kind: 'tooling', reason: 'a tool' }, 'market/unsupported-other'],
      [{ kind: 'other', reason: 'other stuff' }, 'market/unsupported-other'],
    ]
    for (const [answer, code] of expectations) {
      const complete = vi.fn<LlmCompletion>(async () => JSON.stringify(answer))
      const analyzer = new InstallAnalyzer({ complete, provider: 'ds-provider', model: 'deepseek-chat' })
      await expectAsyncMarketError(() => analyzer.analyze(snapshotOf()), code)
    }
  })
})

describe('smart-install vocabulary shape', () => {
  it('keeps exclusions and constants coherent', () => {
    expect(SNAPSHOT_EXCLUDED_TOP_LEVEL).toContain('node_modules')
    expect(SNAPSHOT_EXCLUDED_TOP_LEVEL).toContain('.git')
  })
})
