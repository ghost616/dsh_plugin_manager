/**
 * Smart-install analysis assembly for the market control layer.
 *
 * This module wires the host-side analysis primitives (market/analyze.ts) into
 * the injectable completion backend this layer must provide:
 * - {@link createLlmCompletion} builds the real `LlmCompletion` over a narrow
 *   structural view of the dsh `ctx.llm` stream service. The full dsh-llm
 *   runtime types are a harness dependency this package does not link, so the
 *   chunk protocol is modelled structurally and the runtime objects are
 *   consumed as-is. Terminal `finish` errors (`error`/`aborted`) and transport
 *   throws normalize to the stable `market/llm-failed` code; a deadline signal
 *   aborts the request through an AbortController. A completion failure is
 *   NEVER a green light: callers treat any non-installable outcome — refusal
 *   or error alike — as "not installable", so an analysis that cannot run must
 *   refuse the candidate, never silently pass it.
 * - {@link snapshotFromPreview} approximates the analyzer input from remote
 *   preview data (README text + the manifest preview outcome), so a
 *   very-unconventional candidate can be classified before any local checkout
 *   exists.
 * - {@link runCheckoutAnalysis} runs the host `InstallAnalyzer` over one
 *   snapshot and returns its classification distribution (the persisted
 *   `plugin` | `skills` | `other` tag, the entry that came with it, the model
 *   rationale and the build-required flag). Classifying is not a gate: the
 *   caller files the checkout with that tag, while an analyzer failure is
 *   explicitly NOT a green light either — the caller falls back to the
 *   conservative `other` classification and keeps the review installable.
 *
 * Nothing here touches a Cordis context: the llm service is passed in as a
 * structural value so unit tests feed scripted chunk streams.
 */

import { InstallAnalyzer } from '../market/analyze.ts'
import type {
  CheckoutManifestSummary,
  CheckoutSnapshot,
  LlmCompletion,
  PluginAnalysisDistribution,
} from '../market/analyze.ts'
import { MarketError, marketError } from '../market/errors.ts'
import type { PluginMarketClassification, PluginPreviewOutcome } from '../../types.ts'

/* ------------------------------------------------------------------------ */
/* ctx.llm structural surface (the narrow seam we consume)                  */
/* ------------------------------------------------------------------------ */

/** Text delta of one open output block (dsh-llm chunk protocol). */
export interface LlmTextDeltaChunk {
  readonly type: 'text-delta'
  readonly index: number
  readonly text: string
}

/** Terminal assembled text block (dsh-llm chunk protocol). */
export interface LlmBlockEndChunk {
  readonly type: 'block-end'
  readonly index: number
  readonly block: { readonly type: string; readonly text: string }
}

/** Terminal finish chunk carrying the stop reason. */
export interface LlmFinishChunk {
  readonly type: 'finish'
  readonly reason: { readonly kind: string; readonly failure?: { readonly message?: string; readonly code?: string } }
}

/** One raw chunk of the `ctx.llm.stream` protocol we accept. */
export type LlmChunk = LlmTextDeltaChunk | LlmBlockEndChunk | LlmFinishChunk | { readonly type: string }

/** Message content accepted by the narrow stream call. */
export interface LlmTextMessage {
  readonly role: string
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
}

/** Request of the narrow `ctx.llm.stream` call. */
export interface LlmStreamRequest {
  readonly provider: string
  readonly model: string
  /** System prompt text (one-shot callers). */
  readonly system?: string
  readonly messages: readonly LlmTextMessage[]
  readonly signal?: AbortSignal
}

/**
 * Narrow structural view of the dsh LLM runtime. The shipped dsh declares the
 * full `ctx.llm` service; this single-package Program types only the surface
 * this module consumes (mirroring the webServer precedent).
 */
export interface LlmStreamService {
  stream(request: LlmStreamRequest): AsyncIterable<LlmChunk>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Narrow structural view of the dsh LLM runtime (see {@link LlmStreamService}). */
    llm: LlmStreamService
  }
}

/** Default per-call analysis deadline in milliseconds. */
export const ANALYSIS_DEADLINE_MS = 60_000

/** Options for {@link createLlmCompletion}. */
export interface LlmCompletionOptions {
  /** Live `ctx.llm` accessor; null while the service is absent. */
  readonly llm: () => LlmStreamService | null
  /** Per-call deadline in ms (default {@link ANALYSIS_DEADLINE_MS}). */
  readonly deadlineMs?: number
}

/**
 * Build the real analysis completion over `ctx.llm.stream`. Text is assembled
 * from the chunk protocol; a terminal `error`/`aborted` finish (or any throw
 * while iterating) surfaces as `market/llm-failed`, so the analyzer never sees
 * a transport error disguised as output. The deadline aborts the request.
 * Any failure thrown here leaves the candidate unclassified — the source layer
 * refuses the preview (never silently allowing the install) and the UI can
 * retry on the stable `market/llm-failed` code.
 */
export function createLlmCompletion(options: LlmCompletionOptions): LlmCompletion {
  const deadlineMs = options.deadlineMs ?? ANALYSIS_DEADLINE_MS
  return async (request) => {
    const service = options.llm()
    if (service === null) {
      throw marketError(
        'market/llm-unconfigured',
        'The smart-install analyzer needs the dsh LLM service; ensure a chat provider is active on the composition context.',
      )
    }
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), deadlineMs)
    try {
      const streamRequest: LlmStreamRequest = {
        provider: request.provider,
        model: request.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
        signal: controller.signal,
        ...(request.system !== undefined && request.system.length > 0 ? { system: request.system } : {}),
      }
      const chunks = service.stream(streamRequest)
      const text = await assembleStreamText(chunks)
      if (text.trim().length === 0) {
        throw marketError('market/llm-failed', 'The analysis model returned an empty answer; retry or reconfigure the model.')
      }
      return text
    } catch (error) {
      if (error instanceof MarketError) throw error
      if (controller.signal.aborted) {
        throw marketError('market/llm-failed', `The smart-install analysis timed out after ${deadlineMs} ms.`)
      }
      throw new MarketError('market/llm-failed', 'The smart-install analysis model call failed.', { cause: error })
    } finally {
      clearTimeout(deadline)
    }
  }
}

/** Consume one chunk stream into the concatenated assistant text. */
async function assembleStreamText(chunks: AsyncIterable<LlmChunk>): Promise<string> {
  // Per-block assembly mirroring BlockAssembler semantics: text deltas append
  // to their open block; a `block-end` carries the authoritative assembled
  // text of that block (it replaces any prior deltas and closes the block).
  // Blocks are keyed by their chunk index and concatenated in index order at
  // the end, so a transport that interleaves out-of-order chunks (or a late
  // block whose deltas arrived first) still yields deterministic text instead
  // of arrival-order garbage.
  const byIndex = new Map<number, { text: string; closed: boolean }>()
  let terminal: LlmFinishChunk | undefined
  for await (const chunk of chunks) {
    if (isTextDeltaChunk(chunk)) {
      let entry = byIndex.get(chunk.index)
      if (entry === undefined) {
        entry = { text: '', closed: false }
        byIndex.set(chunk.index, entry)
      }
      if (!entry.closed) entry.text += chunk.text
    } else if (isTextBlockEndChunk(chunk)) {
      let entry = byIndex.get(chunk.index)
      if (entry === undefined) {
        entry = { text: '', closed: false }
        byIndex.set(chunk.index, entry)
      }
      entry.text = chunk.block.text
      entry.closed = true
    } else if (isFinishChunk(chunk)) {
      terminal = chunk
    }
  }
  const reason = terminal?.reason
  if (reason !== undefined && (reason.kind === 'error' || reason.kind === 'aborted')) {
    const detail = reason.failure?.message ?? reason.failure?.code ?? reason.kind
    throw marketError('market/llm-failed', `The smart-install analysis model call failed (${detail}).`)
  }
  const indexes = [...byIndex.keys()].sort((a, b) => a - b)
  return indexes.map(index => byIndex.get(index)?.text ?? '').join('')
}

/** Narrow a raw chunk to the text-delta member (unknown chunks are skipped). */
function isTextDeltaChunk(chunk: LlmChunk): chunk is LlmTextDeltaChunk {
  return chunk.type === 'text-delta'
    && typeof (chunk as { text?: unknown }).text === 'string'
    && typeof (chunk as { index?: unknown }).index === 'number'
}

/** Narrow a raw chunk to a closed text block (unknown blocks are skipped). */
function isTextBlockEndChunk(chunk: LlmChunk): chunk is LlmBlockEndChunk {
  return chunk.type === 'block-end'
    && typeof (chunk as { index?: unknown }).index === 'number'
    && typeof (chunk as { block?: unknown }).block === 'object'
    && (chunk as { block?: { type?: unknown; text?: unknown } }).block?.type === 'text'
    && typeof (chunk as { block?: { type?: unknown; text?: unknown } }).block?.text === 'string'
}

/** Narrow a raw chunk to the terminal finish member. */
function isFinishChunk(chunk: LlmChunk): chunk is LlmFinishChunk {
  return chunk.type === 'finish'
    && typeof (chunk as { reason?: unknown }).reason === 'object'
    && (chunk as { reason?: { kind?: unknown } }).reason?.kind !== undefined
}

/* ------------------------------------------------------------------------ */
/* Preview snapshot                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Approximate a checkout snapshot from remote preview data. `readme` is the
 * raw README Markdown when the repository has one; the preview outcome
 * contributes a package.json summary only when the manifest was readable
 * (`ready`). Very-unconventional candidates (degraded preview, no readable
 * manifest) yield `manifest: null` with the README as the only content the
 * model can judge — install-time callers that already have a real checkout
 * should prefer {@link collectCheckoutSnapshot} output instead.
 */
export function snapshotFromPreview(readme: string | null, preview: PluginPreviewOutcome): CheckoutSnapshot {
  const manifest: CheckoutManifestSummary | null = preview.status === 'ready'
    ? {
      name: preview.summary.name,
      version: preview.summary.version,
      description: null,
      main: null,
      hasBuildScript: false,
    }
    : null
  return { readme, entries: [], topLevelCount: 0, manifest }
}

/* ------------------------------------------------------------------------ */
/* Decision mapping                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Checkout classification kinds exposed to the control decision: the persisted
 * classification label vocabulary (`plugin` | `skills` | `other`). The richer
 * analyzer vocabulary (preset/tooling) is folded into `other` by the host
 * analyzer, so a review never carries a kind the classification tag cannot.
 */
export type AnalysisCheckoutKind = PluginMarketClassification

/** Options for {@link runCheckoutAnalysis}. */
export interface RunCheckoutAnalysisOptions {
  /** Completion backend (production: {@link createLlmCompletion}). */
  readonly complete: LlmCompletion
  /** LLM provider id (from Config.llm). */
  readonly provider?: string
  /** LLM model id (from Config.llm). */
  readonly model?: string
  /**
   * Optional checkout file probe: refuses a plugin verdict whose entry is not
   * present in the analyzed checkout (see the analyzer `hasFile` option).
   */
  readonly hasFile?: (relativeEntry: string) => boolean | Promise<boolean>
}

/**
 * Run the host analyzer over one checkout snapshot and return its
 * classification distribution as-is. This is NOT a gate: a `skills`/`other`
 * distribution (or a plugin whose entry still needs a build) is a filing
 * decision the caller carries into the record and the review, never a refusal
 * — an unconventional checkout is downloaded, classified and kept.
 *
 * Analyzer failures (an unconfigured endpoint, model transport errors,
 * unparsable output, an I/O failure while probing the entry) still propagate
 * with their stable codes: the caller then falls back to the conservative
 * `other` classification (see `MarketSourceOperations`) instead of blocking the
 * review.
 */
export async function runCheckoutAnalysis(
  snapshot: CheckoutSnapshot,
  options: RunCheckoutAnalysisOptions,
): Promise<PluginAnalysisDistribution> {
  const analyzer = new InstallAnalyzer({
    complete: options.complete,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.hasFile === undefined ? {} : { hasFile: options.hasFile }),
  })
  return analyzer.analyze(snapshot)
}
