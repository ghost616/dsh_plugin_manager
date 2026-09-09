/**
 * Unit spec of the smart-install analysis assembly (src/host/control/analysis.ts).
 * Covers the structural ctx.llm completion (text assembly, finish-error and
 * deadline mapping) and the host-analyzer verdict mapping used by the source
 * operations.
 */
import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_DEADLINE_MS,
  createLlmCompletion,
  refusalWireCode,
  runCheckoutAnalysis,
  snapshotFromPreview,
  type CheckoutAnalysisDecision,
  type LlmChunk,
  type LlmStreamService,
} from '../src/host/control/analysis.ts'
import type { CheckoutSnapshot } from '../src/host/market/analyze.ts'

/** One user-visible snapshot fed to the verdict tests. */
function snapshotOf(overrides: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot {
  return {
    readme: '# sample\n\nA candidate repository README.',
    entries: [
      { name: 'README.md', directory: false },
      { name: 'skills', directory: true },
    ],
    topLevelCount: 2,
    manifest: null,
    ...overrides,
  }
}

/** Scriptable chunk stream for the completion tests. */
function streamOf(chunks: readonly LlmChunk[]): LlmStreamService {
  return { stream: async function* () { yield* chunks } }
}

describe('createLlmCompletion (structural ctx.llm stream)', () => {
  it('assembles text deltas into the analyzer text', async () => {
    const complete = createLlmCompletion({ llm: () => streamOf([
      { type: 'text-delta', index: 0, text: '{"kind":' },
      { type: 'text-delta', index: 0, text: '"plugin","reason":"ok"}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) })
    const text = await complete({
      provider: 'ds-provider',
      model: 'deepseek-chat',
      system: 'system',
      user: 'user',
    })
    expect(text).toBe('{"kind":"plugin","reason":"ok"}')
  })

  it('honors a terminal text block as the authoritative assembly of its index', async () => {
    const complete = createLlmCompletion({ llm: () => streamOf([
      { type: 'text-delta', index: 0, text: 'stale-prefix' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '{"kind":"plugin","reason":"ok"}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) })
    const text = await complete({ provider: 'p', model: 'm', system: '', user: 'u' })
    expect(text).toBe('{"kind":"plugin","reason":"ok"}')
  })

  it('ignores deltas that arrive after their block closed', async () => {
    const complete = createLlmCompletion({ llm: () => streamOf([
      { type: 'block-end', index: 0, block: { type: 'text', text: '{"kind":"plugin"}' } },
      { type: 'text-delta', index: 0, text: 'late-and-stale' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) })
    const text = await complete({ provider: 'p', model: 'm', system: '', user: 'u' })
    expect(text).toBe('{"kind":"plugin"}')
  })

  it('skips unknown chunk types and reasoning deltas', async () => {
    const complete = createLlmCompletion({ llm: () => streamOf([
      { type: 'reasoning-delta', index: 0, text: 'thinking...' } as unknown as LlmChunk,
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as LlmChunk,
      { type: 'text-delta', index: 0, text: '{"kind":"plugin"}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) })
    const text = await complete({ provider: 'p', model: 'm', system: '', user: 'u' })
    expect(text).toBe('{"kind":"plugin"}')
  })

  it('maps a terminal error finish to market/llm-failed', async () => {
    const complete = createLlmCompletion({ llm: () => streamOf([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'X' } } },
    ]) })
    await expect(complete({ provider: 'p', model: 'm', system: '', user: 'u' }))
      .rejects.toMatchObject({ code: 'market/llm-failed' })
  })

  it('maps an aborted finish to market/llm-failed', async () => {
    const complete = createLlmCompletion({ llm: () => streamOf([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } },
    ]) })
    await expect(complete({ provider: 'p', model: 'm', system: '', user: 'u' }))
      .rejects.toMatchObject({ code: 'market/llm-failed' })
  })

  it('maps an absent llm service to market/llm-unconfigured', async () => {
    const complete = createLlmCompletion({ llm: () => null })
    await expect(complete({ provider: 'p', model: 'm', system: '', user: 'u' }))
      .rejects.toMatchObject({ code: 'market/llm-unconfigured' })
  })

  it('maps an empty answer to market/llm-failed', async () => {
    const complete = createLlmCompletion({ llm: () => streamOf([
      { type: 'finish', reason: { kind: 'stop' } },
    ]) })
    await expect(complete({ provider: 'p', model: 'm', system: '', user: 'u' }))
      .rejects.toMatchObject({ code: 'market/llm-failed' })
  })

  it('aborts the request when the deadline fires and reports market/llm-failed', async () => {
    let sawSignal = false
    const never = {
      stream(request: { signal?: AbortSignal }) {
        sawSignal = request.signal !== undefined
        return (async function* () {
          await new Promise(resolve => setTimeout(resolve, 20))
          yield { type: 'finish' as const, reason: { kind: 'stop' } }
        })()
      },
    } satisfies LlmStreamService
    const complete = createLlmCompletion({ llm: () => never, deadlineMs: 5 })
    await expect(complete({ provider: 'p', model: 'm', system: '', user: 'u' }))
      .rejects.toMatchObject({ code: 'market/llm-failed' })
    expect(sawSignal).toBe(true)
  })

  it('uses the documented default deadline when none is given', () => {
    expect(ANALYSIS_DEADLINE_MS).toBe(60_000)
  })
})

describe('runCheckoutAnalysis verdict mapping', () => {
  it('maps a plugin verdict to installable', async () => {
    const decision = await runCheckoutAnalysis(snapshotOf(), {
      complete: async () => JSON.stringify({ kind: 'plugin', reason: 'a plugin', entryHint: 'index.js' }),
      provider: 'p',
      model: 'm',
    })
    expect(decision).toEqual({ installable: true })
  })

  it('maps a skills rejection to a skills refusal with the model reason', async () => {
    const decision = await runCheckoutAnalysis(snapshotOf(), {
      complete: async () => JSON.stringify({ kind: 'skills', reason: 'A Claude skills collection' }),
      provider: 'p',
      model: 'm',
    })
    expect(decision).toEqual({ installable: false, kind: 'skills', reason: 'A Claude skills collection' })
  })

  it('maps preset/tooling/other kinds to preset/other refusals', async () => {
    const cases: { kind: string; expected: 'preset' | 'other' }[] = [
      { kind: 'preset', expected: 'preset' },
      { kind: 'tooling', expected: 'other' },
      { kind: 'other', expected: 'other' },
    ]
    for (const item of cases) {
      const decision = await runCheckoutAnalysis(snapshotOf(), {
        complete: async () => JSON.stringify({ kind: item.kind, reason: `it is ${item.kind}` }),
        provider: 'p',
        model: 'm',
      })
      expect(decision.installable).toBe(false)
      if (!decision.installable) expect(decision.kind).toBe(item.expected)
    }
  })

  it('propagates market/llm-bad-output verbatim', async () => {
    const promise = runCheckoutAnalysis(snapshotOf(), {
      complete: async () => 'not json at all',
      provider: 'p',
      model: 'm',
    })
    await expect(promise).rejects.toMatchObject({ code: 'market/llm-bad-output' })
  })

  it('maps a hasFile probe of a missing plugin entry to a build refusal', async () => {
    const decision: CheckoutAnalysisDecision = await runCheckoutAnalysis(snapshotOf(), {
      complete: async () => JSON.stringify({ kind: 'plugin', reason: 'needs build', entryHint: 'dist/index.js' }),
      provider: 'p',
      model: 'm',
      hasFile: async () => false,
    })
    expect(decision.installable).toBe(false)
    if (!decision.installable) {
      expect(decision.kind).toBe('plugin')
      expect(decision.reason).toContain('dist/index.js')
    }
  })

  it('propagates a configured llm rejection when provider/model are absent', async () => {
    const promise = runCheckoutAnalysis(snapshotOf(), { complete: async () => '{}' })
    await expect(promise).rejects.toMatchObject({ code: 'market/llm-unconfigured' })
  })
})

describe('snapshotFromPreview + refusalWireCode', () => {
  it('builds a manifest-less snapshot for a degraded (unconventional) preview', () => {
    const snapshot = snapshotFromPreview('# readme', {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'unreadable',
      code: 'github/not-found',
    })
    expect(snapshot.readme).toBe('# readme')
    expect(snapshot.manifest).toBeNull()
    expect(snapshot.entries).toEqual([])
  })

  it('maps refusal kinds to their unsupported wire codes', () => {
    expect(refusalWireCode('skills')).toBe('market/unsupported-skills')
    expect(refusalWireCode('preset')).toBe('market/unsupported-preset')
    expect(refusalWireCode('plugin')).toBe('market/unsupported-build')
    expect(refusalWireCode('tooling')).toBe('market/unsupported-other')
    expect(refusalWireCode('other')).toBe('market/unsupported-other')
  })
})
