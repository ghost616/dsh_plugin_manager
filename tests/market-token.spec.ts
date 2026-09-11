/**
 * Unit coverage of the credential-seam backed GitHub token source:
 *
 * - reference precedence (`DSH_GITHUB_TOKEN` preferred, `GITHUB_TOKEN` second)
 *   and the anonymous answer when neither is configured;
 * - one resolution per request — a token changed between two requests is what
 *   the next request sends, and nothing is memoized;
 * - anonymous fallback when this deployment mounts no credential seam at all
 *   (a bare cordis `Context` is the real-shape witness of that runtime fact) and
 *   when the seam itself fails;
 * - the loud `github/token-unavailable` gate for surfaces that need the seam.
 *
 * The fake seam is a structurally-cast plain object on purpose: `Context`
 * declares `credentials` unconditionally, so the mounted/unmounted distinction
 * this module acts on is a runtime fact that no type can express. The fake
 * implements exactly the two methods the token half uses (`resolve` /
 * `describe`), which is why the cast cannot hide a missing member.
 */

import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { MarketError } from '../src/host/market/errors.ts'
import {
  CREDENTIALS_GITHUB_TOKEN_REFS,
  GITHUB_TOKEN_FALLBACK_REF,
  GITHUB_TOKEN_REF,
  credentialsServiceOf,
  credentialsTokenProvider,
  gitHubTokenSourceOf,
  hasCredentialsSeam,
  requireCredentials,
  resolveGitHubToken,
} from '../src/host/market/token.ts'

/** One fake credential value as the seam would answer it. */
interface FakeSeamEntry {
  readonly value: string
  readonly sourceLabel?: string
}

/** One installed fake value, keyed by the reference it answers. */
type FakeSeamTable = Map<string, FakeSeamEntry>

/** Build a {@link Context}-shaped credential seam over a fixed ref table. */
function fakeSeam(options: {
  readonly dsh?: FakeSeamEntry
  readonly plain?: FakeSeamEntry
  readonly fail?: boolean
} = {}): { readonly ctx: Context; readonly table: FakeSeamTable; readonly resolved: string[] } {
  const table: FakeSeamTable = new Map()
  if (options.dsh !== undefined) table.set(GITHUB_TOKEN_REF, options.dsh)
  if (options.plain !== undefined) table.set(GITHUB_TOKEN_FALLBACK_REF, options.plain)
  const resolved: string[] = []
  const seam = {
    async resolve(ref: string): Promise<FakeSeamEntry | undefined> {
      resolved.push(ref)
      if (options.fail === true) throw new Error('credential store offline')
      return table.get(ref)
    },
    async describe(ref: string): Promise<{ configured: boolean; writable: boolean; source?: string }> {
      const entry = table.get(ref)
      if (entry === undefined) return { configured: false, writable: true }
      return entry.sourceLabel === undefined
        ? { configured: true, writable: true }
        : { configured: true, writable: true, source: entry.sourceLabel }
    },
  }
  // The seam is reached through the inject-free service lookup the real cordis
  // context provides (`ctx.get('credentials')`), not through the proxied
  // `ctx.credentials` property — see the module header. A double that answered
  // only the property would silently test a path production never takes.
  return {
    ctx: { get: (name: string) => (name === 'credentials' ? seam : undefined) } as unknown as Context,
    table,
    resolved,
  }
}

/** The fake seam as the module's own accessor sees it (never null here). */
function seamOf(ctx: Context): CredentialProvider {
  const credentials = credentialsServiceOf(ctx)
  if (credentials === null) throw new Error('expected the fake seam to be visible')
  return credentials
}

/** Await a rejection and hand back the asserted {@link MarketError}. */
async function caughtError(action: () => unknown): Promise<MarketError> {
  try {
    await action()
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    return error as MarketError
  }
  throw new Error('expected the call to reject, but it resolved')
}

describe('resolveGitHubToken', () => {
  it('prefers DSH_GITHUB_TOKEN and falls back to GITHUB_TOKEN', async () => {
    const both = fakeSeam({ dsh: { value: 'dsh-token' }, plain: { value: 'plain-token' } })
    expect(await resolveGitHubToken(both.ctx)).toBe('dsh-token')
    // The preferred head answered, so the second reference was never consulted.
    expect(both.resolved).toEqual([GITHUB_TOKEN_REF])

    const onlySecond = fakeSeam({ plain: { value: 'plain-token' } })
    expect(await resolveGitHubToken(onlySecond.ctx)).toBe('plain-token')
    expect(onlySecond.resolved).toEqual([GITHUB_TOKEN_REF, GITHUB_TOKEN_FALLBACK_REF])
    expect([...CREDENTIALS_GITHUB_TOKEN_REFS]).toEqual([GITHUB_TOKEN_REF, GITHUB_TOKEN_FALLBACK_REF])
  })

  it('goes anonymous while neither reference is configured', async () => {
    const empty = fakeSeam()
    expect(await resolveGitHubToken(empty.ctx)).toBeNull()
    // Both references were asked, and both answered "absent".
    expect(empty.resolved).toHaveLength(2)
    // An empty stored value counts as absent everywhere (the seam's own rule).
    const blank = fakeSeam({ dsh: { value: '' } })
    expect(await resolveGitHubToken(blank.ctx)).toBeNull()
  })

  it('re-resolves on every request instead of memoizing a value', async () => {
    const rotated = fakeSeam({ dsh: { value: 'token-v1' } })
    const provider = credentialsTokenProvider(rotated.ctx)
    expect(await provider()).toBe('token-v1')
    // A save between requests is the seam's `set`: the next request must see the
    // new value with no cache (or restart) in between.
    rotated.table.set(GITHUB_TOKEN_REF, { value: 'token-v2' })
    expect(await provider()).toBe('token-v2')
    expect(await provider()).toBe('token-v2')
    expect(rotated.resolved).toHaveLength(3)
  })

  it('answers anonymously, with a diagnostic, when the seam itself fails', async () => {
    const broken = fakeSeam({ fail: true })
    const warnings: string[] = []
    expect(await resolveGitHubToken(broken.ctx, { onResolveError: (message) => warnings.push(message) })).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('credential store offline')
    // The diagnostic carries no token value — none was ever read.
    expect(warnings[0]).not.toContain('token-')
  })

  it('answers anonymously when the deployment mounted no credential seam', async () => {
    const bare = new Context()
    // A bare root context answers `undefined` for an unmounted declared service,
    // which is the fact this module's structural check consumes. It is NOT the
    // witness for the raw-property-read hazard below: a root context tolerates
    // the property read, only a plugin-scoped context does not.
    expect((bare as unknown as { credentials?: unknown }).credentials).toBeUndefined()
    expect(hasCredentialsSeam(bare)).toBe(false)
    expect(credentialsServiceOf(bare)).toBeNull()
    expect(await resolveGitHubToken(bare)).toBeNull()
    expect(await credentialsTokenProvider(bare)()).toBeNull()
  })

  it('reads a provided seam through the inject-free lookup', async () => {
    // Regression pin for the inject-free read (see the module header): the
    // module must reach the seam through `ctx.get`, never through the proxied
    // `ctx.credentials` property.
    const ctx = new Context()
    const seam = fakeSeam({ dsh: { value: 'seam-token' } })
    ctx.provide('credentials', seamOf(seam.ctx))
    expect(credentialsServiceOf(ctx)).not.toBeNull()
    expect(hasCredentialsSeam(ctx)).toBe(true)
    expect(await resolveGitHubToken(ctx)).toBe('seam-token')
    expect(await credentialsTokenProvider(ctx)()).toBe('seam-token')
  })

  it('services a GitHub read from inside a plugin scope that never declared credentials', async () => {
    // The hazard the inject-free read exists for, reproduced where it actually
    // happens: a plugin fiber whose context never declared the `credentials`
    // accessor (no credential plugin is loaded). Reading `ctx.credentials`
    // there THROWS "cannot get property \"credentials\" without inject", which
    // would fail every GitHub read of such a deployment — while a bare root
    // context would have answered `undefined` and hidden it. This is the
    // faithful pin for the fix (a plugin-scoped witness, not the root one).
    const ctx = new Context()
    let scoped: Context | null = null
    const probe = {
      name: 'token-scope-probe',
      inject: [],
      apply(pluginCtx: Context): void {
        scoped = pluginCtx
      },
    }
    await ctx.plugin(probe)
    const pluginCtx = scoped as Context | null
    if (pluginCtx === null) throw new Error('expected the probe plugin to capture its context')

    // The raw property read is the defect; it must throw here.
    expect(() => (pluginCtx as unknown as { credentials?: unknown }).credentials).toThrow(/credentials/)
    // The module's answer is unaffected by that proxy rule: anonymous, no throw.
    expect(hasCredentialsSeam(pluginCtx)).toBe(false)
    expect(credentialsServiceOf(pluginCtx)).toBeNull()
    expect(await resolveGitHubToken(pluginCtx)).toBeNull()
  })
})

describe('gitHubTokenSourceOf', () => {
  it('reports the configured source layer and nothing while unconfigured', async () => {
    const seam = fakeSeam({ dsh: { value: 'dsh-token', sourceLabel: 'env' } })
    expect(await gitHubTokenSourceOf(seamOf(seam.ctx), GITHUB_TOKEN_REF)).toBe('env')
    const empty = fakeSeam()
    expect(await gitHubTokenSourceOf(seamOf(empty.ctx), GITHUB_TOKEN_REF)).toBeUndefined()
  })
})

describe('requireCredentials', () => {
  it('fails loudly with github/token-unavailable and no launch-environment fallback', async () => {
    const bare = new Context()
    const error = await caughtError(() => requireCredentials(bare))
    expect(error.code).toBe('github/token-unavailable')
    expect(error.message).toContain('no credential seam')
    expect(error.details).toEqual({})
  })

  it('hands back the mounted seam unchanged', async () => {
    const seam = fakeSeam({ dsh: { value: 'dsh-token' } })
    expect(requireCredentials(seam.ctx)).toBe(seamOf(seam.ctx))
  })
})
