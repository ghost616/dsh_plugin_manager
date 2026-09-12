/**
 * 离朱 independent verification (round 7): the host-side `maskedHint` mask.
 *
 * Independent by construction: the production port (`buildCredentialTokenPort`)
 * over my own two-layer seam double with CALL COUNTERS (so "no second service
 * lookup" and "nothing is cached" are measured, not assumed), the tsc-emitted
 * gateway/web-channel artifacts over real localhost HTTP, hand-computed
 * boundary expectations (not a copy of the implementation), a generated corpus
 * for the mechanical red lines, and a real read of `lib/client.js`.
 *
 * Boundary probes beyond the module's own suite:
 *  - every length edge 0/1/4/8/9/12/13/ultra-long, underscore-free and with the
 *    underscore at index 0 / 11 / 12 / 13 / repeated / all-underscores;
 *  - `ctx.get('credentials')` call counts per status/save/clear (exactly one),
 *    and per consecutive pair (two) — no service or value caching;
 *  - an unconfigured read performs ZERO resolves (the mask is read only in the
 *    configured branch);
 *  - a seam with NO `resolve` member at all, a throwing resolve, and a resolve
 *    answering an empty value: all degrade to "field absent", never an error;
 *  - the red line mechanically: the mask never contains the plaintext, the dot
 *    run is always exactly eight, and only the mask changes when only the value
 *    changes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  GITHUB_TOKEN_FALLBACK_REF,
  GITHUB_TOKEN_REF,
} from '../src/host/market/token.ts'
import { buildCredentialTokenPort, maskOf } from '../src/host/control/token.ts'
import type { MarketRepository } from '../src/host/market/index.ts'
import {
  MarketSourceOperations,
  type InstallerPort,
  type MarketSourceDeps,
  type RepositoryDetailPort,
  type SearchEnginePort,
} from '../src/host/control/source.ts'
import { MarketControllerGateway } from '../lib/types/host/control/gateway.js'
import { MARKET_WEB_ROUTE_PATH, registerMarketWebChannel } from '../lib/types/host/control/web-channel.js'

const HEAD = GITHUB_TOKEN_REF as unknown as string
const FALLBACK = GITHUB_TOKEN_FALLBACK_REF as unknown as string
const DOTS = String.fromCharCode(0x2022).repeat(8)

const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

/** Two-layer seam double with call counters (env outranks the writable store). */
class Seam {
  readonly env = new Map<string, string>()
  readonly store = new Map<string, string>()
  readonly setCalls: { ref: string; value: string }[] = []
  readonly unsetCalls: string[] = []
  readonly resolveCalls: string[] = []
  readonly describeCalls: string[] = []
  throwOnResolve = false
  emptyOnResolve = false

  private name(ref: CredentialRef | string): string {
    return ref as unknown as string
  }

  valueOf(name: string): string | undefined {
    const env = this.env.get(name)
    if (env !== undefined && env.length > 0) return env
    const stored = this.store.get(name)
    return stored !== undefined && stored.length > 0 ? stored : undefined
  }

  async describe(ref: CredentialRef): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    const name = this.name(ref)
    this.describeCalls.push(name)
    const env = this.env.get(name)
    if (env !== undefined && env.length > 0) return { configured: true, source: 'env', writable: false }
    const stored = this.store.get(name)
    if (stored !== undefined && stored.length > 0) return { configured: true, source: 'file', writable: true }
    return { configured: false, writable: true }
  }

  async resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined> {
    const name = this.name(ref)
    this.resolveCalls.push(name)
    if (this.throwOnResolve) throw new Error('credential read failed')
    if (this.emptyOnResolve) return { value: '', source: 'file' }
    const value = this.valueOf(name)
    if (value === undefined) return undefined
    return { value, source: this.env.has(name) ? 'env' : 'file' }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.setCalls.push({ ref: this.name(ref), value })
    this.store.set(this.name(ref), value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.unsetCalls.push(this.name(ref))
    this.store.delete(this.name(ref))
  }
}

/** Context double that counts the inject-free credentials lookups. */
class CountingCtx {
  gets = 0
  constructor(private readonly seam: unknown) {}
  get(name: string): unknown {
    if (name !== 'credentials') return undefined
    this.gets += 1
    return this.seam
  }
}

/** Real cordis context with the seam provided (the wire-path case). */
function realCtx(seam: unknown): Context {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('credentials', seam as CredentialProvider)
  return ctx
}

/** The seam without its `resolve` member at all (describe/set/unset only). */
function seamWithoutResolve(seam: Seam): unknown {
  return {
    describe: (ref: CredentialRef) => seam.describe(ref),
    set: (ref: CredentialRef, value: string) => seam.set(ref, value),
    unset: (ref: CredentialRef) => seam.unset(ref),
  }
}

/**
 * Independent oracle of the documented rule (hand-checked against the table).
 *
 * The last clause is the reconstruction guard the defect round added: when the
 * kept characters would cover the whole value, the mask degrades to the dots
 * alone. Without it a value whose first underscore is its last character echoes
 * itself in full.
 */
function oracleMask(value: string): string {
  if (value.length <= 8) return DOTS
  const underscore = value.indexOf('_')
  const raw = underscore === -1 ? '' : value.slice(0, underscore + 1)
  const prefix = raw.slice(0, 12)
  const suffix = value.slice(value.length - 4)
  if (prefix.length + suffix.length >= value.length) return DOTS
  return `${prefix}${DOTS}${suffix}`
}

function dotCount(mask: string): number {
  return [...mask].filter(char => char === String.fromCharCode(0x2022)).length
}
// ---------------------------------------------------------------------------
// A. The mask rule: hand-computed boundaries + a generated corpus
// ---------------------------------------------------------------------------

describe('LIZHU probe A: maskOf boundaries and mechanical red lines', () => {
  it('matches the hand-computed mask for every length and underscore position', () => {
    const table: [string, string][] = [
      // length edges, underscore-free
      ['', DOTS],
      ['a', DOTS],
      ['abcd', DOTS],
      ['abcdefgh', DOTS],
      ['abcdefghi', `${DOTS}fghi`],
      ['abcdefghijkl', `${DOTS}ijkl`],
      ['abcdefghijklm', `${DOTS}jklm`],
      // short-value protection (<= 8) never keeps a character
      ['ghp_1234', DOTS],
      ['ghp_12345', `ghp_${DOTS}2345`],
      // the plaintext shapes named by the requirement
      ['ghp_FAKEPLAINTEXT9abcdefghijklmnop4XYZ', `ghp_${DOTS}4XYZ`],
      ['abcdefghijklmnop_qrstuvwxyz', `abcdefghijkl${DOTS}wxyz`],
      ['abcdefgh12345678wxyz', `${DOTS}wxyz`],
      // prefix cap: the underscore is included at index 11, dropped at index 12
      ['abcdefghijk_lmnopqrst', `abcdefghijk_${DOTS}qrst`],
      ['abcdefghijkl_mnopqrst', `abcdefghijkl${DOTS}qrst`],
      // leading, repeated and all-underscore values
      ['_abcdefghijklmnop', `_${DOTS}mnop`],
      ['aa_bb_cc_dd_ee_ff', `aa_${DOTS}e_ff`],
      ['____________', `_${DOTS}____`],
      ['_________', `_${DOTS}____`],
      [`ghp_${'a'.repeat(400)}4XYZ`, `ghp_${DOTS}4XYZ`],
    ]
    const wrong = table
      .filter(([value, expected]) => maskOf(value) !== expected)
      .map(([value, expected]) => `${JSON.stringify(value.slice(0, 24))} -> ${maskOf(value)} (expected ${expected})`)
    expect(wrong).toEqual([])
  })

  it('holds the red lines over a generated corpus of lengths and underscore positions', () => {
    const violations: string[] = []
    const recoverable: string[] = []
    const recoverableLengths: number[] = []
    let underscoreFreeRecoverable = 0
    for (let length = 1; length <= 48; length += 1) {
      for (let underscore = -1; underscore < length; underscore += 1) {
        const value = underscore === -1
          ? 'a'.repeat(length)
          : `${'a'.repeat(underscore)}_${'b'.repeat(length - underscore - 1)}`
        const mask = maskOf(value)
        const label = `len=${length} at=${underscore}`
        if (mask !== oracleMask(value)) violations.push(`${label}: ${mask} != oracle`)

        // Red line: the dot run is fixed at eight, whatever the value length.
        if (dotCount(mask) !== 8) violations.push(`${label}: ${dotCount(mask)} dots`)
        if (length <= 8) {
          if (mask !== DOTS) violations.push(`${label}: short value kept characters`)
        } else {
          const underscoreAt = value.indexOf('_')
          const raw = underscoreAt === -1 ? '' : value.slice(0, underscoreAt + 1)
          const fullPrefix = raw.slice(0, 12)
          const suffix = value.slice(length - 4)
          const degraded = fullPrefix.length + suffix.length >= value.length
          if (degraded) {
            // The reconstruction guard: no character of the value may survive.
            if (mask !== DOTS) violations.push(`${label}: recoverable value did not degrade`)
            if (mask.includes(value)) violations.push(`${label}: mask echoes the value`)
          } else {
            if (!mask.startsWith(fullPrefix)) violations.push(`${label}: prefix mismatch`)
            if (!mask.endsWith(suffix)) violations.push(`${label}: suffix mismatch`)
            if (mask.split(DOTS).join('') !== `${fullPrefix}${suffix}`) {
              violations.push(`${label}: dots are not the only redaction`)
            }
            if (underscoreAt === -1 && fullPrefix !== '') violations.push(`${label}: prefix without underscore`)
            if (`${fullPrefix}${suffix}` === value) recoverable.push(label)
          }
        }
        if (mask.includes(value)) violations.push(`${label}: mask contains the whole value`)
        if (underscore === -1 && `${mask.split(DOTS).join('')}` === value) underscoreFreeRecoverable += 1
      }
    }
    expect(violations).toEqual([])
    // The reconstruction guard closes the whole family the previous round only
    // documented: no prefix + suffix pair may cover the value, so the
    // `recoverable` collector stays empty (it is kept as a witness that the
    // corpus really walks those lengths and underscore positions), and no
    // underscore-free value is recoverable either.
    expect(recoverable).toEqual([])
    expect(underscoreFreeRecoverable).toBe(0)
    // The smallest witnesses, pinned explicitly: the trailing-underscore shape
    // and the general coverage case both degrade to the dots alone.
    expect(maskOf('aaaaaaaa_')).toBe(DOTS)
    expect(maskOf('secretok_')).toBe(DOTS)
    expect(maskOf('abcd_efgh')).toBe(DOTS)
    // A value that leaves a gap between prefix and suffix keeps its shape.
    expect(maskOf('abc_defgh')).toBe(`abc_${DOTS}efgh`)
  })

  it('no longer lets a nine-to-twelve character value whose first underscore is last go out in full', async () => {
    const leaks: string[] = []
    for (let length = 9; length <= 12; length += 1) {
      const value = `${'a'.repeat(length - 1)}_`
      const mask = maskOf(value)
      if (mask.includes(value)) {
        leaks.push(`len=${length} value=${JSON.stringify(value)} mask=${JSON.stringify(mask)}`)
      }
    }
    // End to end: the same shape read through the production port lands in the
    // status (and therefore on the wire) with the plaintext intact, because the
    // prefix "up to and including the first underscore" IS the whole value once
    // that underscore is its last character. The short-value protection does not
    // cover it (the value is longer than eight characters).
    const seam = new Seam()
    const leakedValue = 'secretok_'
    seam.store.set(HEAD, leakedValue)
    const status = await buildCredentialTokenPort(realCtx(seam)).status()
    if (JSON.stringify(status).includes(leakedValue)) {
      leaks.push(`status carries the plaintext: ${JSON.stringify(status)}`)
    }
    expect(leaks).toEqual([])
  })
})
// ---------------------------------------------------------------------------
// B. The port: lookup counts, no caching, degradation
// ---------------------------------------------------------------------------

describe('LIZHU probe B: the mask read is one lookup, uncached and fail-soft', () => {
  it('costs exactly one service lookup and one resolve per status', async () => {
    const seam = new Seam()
    seam.store.set(HEAD, 'ghp_abcdefghijklmnopwxyz')
    const ctx = new CountingCtx(seam)
    const port = buildCredentialTokenPort(ctx as unknown as Context)

    const first = await port.status()
    expect(ctx.gets).toBe(1)
    expect(seam.resolveCalls).toEqual([HEAD])
    expect(first.status.maskedHint).toBe(`ghp_${DOTS}wxyz`)
  })

  it('caches neither the service nor the value (two reads, two lookups)', async () => {
    const seam = new Seam()
    seam.store.set(HEAD, 'ghp_abcdefghijklmnopwxyz')
    const ctx = new CountingCtx(seam)
    const port = buildCredentialTokenPort(ctx as unknown as Context)

    expect((await port.status()).status.maskedHint).toBe(`ghp_${DOTS}wxyz`)
    seam.store.set(HEAD, 'ghp_zzzzzzzzzzzzzzzzABCD')
    const second = await port.status()
    expect(ctx.gets).toBe(2)
    expect(seam.resolveCalls).toEqual([HEAD, HEAD])
    expect(second.status.maskedHint).toBe(`ghp_${DOTS}ABCD`)
  })

  it('resolves nothing at all while the deployment is unconfigured', async () => {
    const seam = new Seam()
    const ctx = new CountingCtx(seam)
    const port = buildCredentialTokenPort(ctx as unknown as Context)

    const status = await port.status()
    expect(ctx.gets).toBe(1)
    // The value is only ever read in the configured branch.
    expect(seam.resolveCalls).toEqual([])
    expect('maskedHint' in status.status).toBe(false)
    expect(JSON.stringify(status)).not.toContain('maskedHint')
    expect(JSON.stringify(status)).not.toContain(String.fromCharCode(0x2022))
  })

  it('keeps a save and a clear at one lookup each, masking the written value', async () => {
    const seam = new Seam()
    const ctx = new CountingCtx(seam)
    const port = buildCredentialTokenPort(ctx as unknown as Context)

    const saved = await port.save('ghp_savedvalue1234WXYZ')
    expect(ctx.gets).toBe(1)
    expect(seam.setCalls).toEqual([{ ref: HEAD, value: 'ghp_savedvalue1234WXYZ' }])
    expect(saved.status.maskedHint).toBe(`ghp_${DOTS}WXYZ`)

    const cleared = await port.clear()
    expect(ctx.gets).toBe(2)
    expect(seam.unsetCalls).toEqual([HEAD])
    expect('maskedHint' in cleared.status).toBe(false)
    expect(cleared.status).toEqual({ configured: false, writable: true, ref: HEAD })
  })

  it('degrades to "no mask" for a seam without resolve, a throwing resolve and an empty value', async () => {
    // (a) the seam has no `resolve` member at all: still a working seam for
    // describe/set/unset, so the status must succeed without the mask.
    const noResolve = new Seam()
    noResolve.store.set(HEAD, 'ghp_abcdefghijklmnopwxyz')
    const statusA = await buildCredentialTokenPort(realCtx(seamWithoutResolve(noResolve))).status()
    expect(statusA.status).toMatchObject({ configured: true, source: 'file', writable: true, ref: HEAD })
    expect('maskedHint' in statusA.status).toBe(false)
    expect(noResolve.setCalls).toEqual([])

    // (b) resolve throws: the read still answers the three state facts, gains no
    // error code, and reports nothing about the failure text.
    const throwing = new Seam()
    throwing.store.set(HEAD, 'ghp_abcdefghijklmnopwxyz')
    throwing.throwOnResolve = true
    const warns: string[] = []
    const portB = buildCredentialTokenPort(realCtx(throwing), {
      logger: { warn: (message) => void warns.push(message), error: () => {} },
    })
    const statusB = await portB.status()
    expect(statusB.status).toMatchObject({ configured: true, source: 'file', writable: true, ref: HEAD })
    expect('maskedHint' in statusB.status).toBe(false)
    expect(warns).toEqual([])
    expect(JSON.stringify(statusB)).not.toContain('credential read failed')

    // (c) resolve answers an empty value: absent, never a placeholder.
    const blank = new Seam()
    blank.store.set(HEAD, 'ghp_abcdefghijklmnopwxyz')
    blank.emptyOnResolve = true
    const statusC = await buildCredentialTokenPort(realCtx(blank)).status()
    expect(statusC.status.configured).toBe(true)
    expect('maskedHint' in statusC.status).toBe(false)
  })

  it('lets only the mask follow the value: every other status field is value-independent', async () => {
    const first = new Seam()
    const second = new Seam()
    first.env.set(HEAD, 'ghp_aaaaaaaaaaaaaaaaaaaa')
    second.env.set(HEAD, 'ghp_bbbbbbbbbbbbbbbbbbbb')
    const a = (await buildCredentialTokenPort(realCtx(first)).status()).status
    const b = (await buildCredentialTokenPort(realCtx(second)).status()).status
    const stripMask = (status: object): Record<string, unknown> => {
      const copy = { ...(status as Record<string, unknown>) }
      delete copy.maskedHint
      return copy
    }
    expect(stripMask(a)).toEqual(stripMask(b))
    expect(a.maskedHint).toBe(`ghp_${DOTS}aaaa`)
    expect(b.maskedHint).toBe(`ghp_${DOTS}bbbb`)
    // The plaintext is in neither the status nor its serialization.
    expect(JSON.stringify(a)).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaa')
    expect(JSON.stringify(b)).not.toContain('ghp_bbbbbbbbbbbbbbbbbbbb')
  })

  it('leaves the write gates untouched (read-only refusal and blank refusal, zero writes)', async () => {
    const readOnly = new Seam()
    readOnly.env.set(HEAD, 'ghp_envvalue1234567890WXYZ')
    const port = buildCredentialTokenPort(realCtx(readOnly))
    expect((await port.status()).status.maskedHint).toBe(`ghp_${DOTS}WXYZ`)
    await expect(port.save('ghp_other')).rejects.toMatchObject({ code: 'github/token-unavailable' })
    await expect(port.clear()).rejects.toMatchObject({ code: 'github/token-unavailable' })
    expect(readOnly.setCalls).toEqual([])
    expect(readOnly.unsetCalls).toEqual([])
    expect([...readOnly.store.keys()]).toEqual([])

    const writable = new Seam()
    const other = buildCredentialTokenPort(realCtx(writable))
    for (const blank of ['', null, undefined]) {
      await expect(other.save(blank)).rejects.toMatchObject({ code: 'github/bad-request' })
    }
    expect(writable.setCalls).toEqual([])
  })
})
// ---------------------------------------------------------------------------
// C. The wire: gateway Remote surface and the real HTTP channel
// ---------------------------------------------------------------------------

class Recorder {
  readonly searchEngine: SearchEnginePort = {
    search: async () => ({ totalCount: 0, items: [] }),
  }
  readonly detailEngine: RepositoryDetailPort = {
    repositoryMeta: async (slug) => ({
      slug,
      name: 'demo-plugin',
      description: null,
      stars: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      url: `https://github.com/${slug}`,
      cloneUrl: `https://github.com/${slug}.git`,
      defaultBranch: 'main',
    }),
    branches: async () => ['main'],
    tags: async () => ['v1.0.0'],
    readme: async () => '# demo\n',
  }
}

const installerStub: InstallerPort = {
  prepare: async () => { throw new Error('installer not used in this spec') },
  classify: async () => { throw new Error('installer not used in this spec') },
  commit: async () => { throw new Error('installer not used in this spec') },
  cancel: async () => false,
}

const emptyRepository = {
  root: '/repo',
  records: {} as unknown as MarketRepository['records'],
  harnessLinks: { scopePath: '/repo/node_modules/@deepseek-ai', links: [] },
  harnessVerified: null,
} as MarketRepository

/** Source operations over a real token port (masking enabled end to end). */
function sourceWith(token: ReturnType<typeof buildCredentialTokenPort>): MarketSourceOperations {
  const recorder = new Recorder()
  const deps: MarketSourceDeps = {
    repository: () => emptyRepository,
    searchEngine: recorder.searchEngine,
    detailEngine: recorder.detailEngine,
    previewEngine: { preview: async () => { throw new Error('preview not used in this spec') } },
    installer: () => installerStub,
    token,
    protection: { isProtectedKey: () => false, isSelfModule: () => false },
    syncRecord: async () => {},
    logger: { warn: () => {}, error: () => {} },
  }
  return new MarketSourceOperations(deps)
}

function gatewayOver(source: MarketSourceOperations): MarketControllerGateway {
  const ctx = new Context()
  contexts.push(ctx)
  const deps = {
    controller: () => null,
    repository: () => emptyRepository,
    source,
    clearGitHubCache: () => false,
  } as unknown as import('../lib/types/host/control/gateway.js').MarketControllerGatewayDeps
  return new MarketControllerGateway(ctx, deps)
}

/** Minimal exact-route webserver shim over a real node listener. */
async function serveChannel(gateway: MarketControllerGateway): Promise<string> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const handler = routes.get(path)
    if (handler === undefined) {
      res.writeHead(404)
      res.end('no route')
      return
    }
    void handler(req, res)
  })
  registerMarketWebChannel({
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }, gateway)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port assigned')
  return `http://127.0.0.1:${address.port}${MARKET_WEB_ROUTE_PATH}`
}

/** One HTTP POST keeping BOTH the raw text and the parsed envelope. */
function post(url: string, body: string): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function callChannel(
  url: string,
  method: string,
  args: Record<string, unknown>,
): Promise<{ status: number; raw: string; value: unknown; error?: { code: string; message: string } }> {
  const answer = await post(url, JSON.stringify({ method, args }))
  const parsed = JSON.parse(answer.raw) as { ok: boolean; value?: unknown; error?: { code: string; message: string } }
  return { status: answer.status, raw: answer.raw, value: parsed.value, ...(parsed.error === undefined ? {} : { error: parsed.error }) }
}

describe('LIZHU probe C: the mask on both wire paths', () => {
  it('carries the mask through the gateway and drops it after a clear', async () => {
    const seam = new Seam()
    const gateway = gatewayOver(sourceWith(buildCredentialTokenPort(realCtx(seam))))
    const plaintext = 'ghp_GATEWAYCANARY0123456789wxyz'

    const saved = await gateway.saveGitHubToken(plaintext)
    expect(saved.status.maskedHint).toBe(`ghp_${DOTS}wxyz`)
    expect(JSON.stringify(saved)).not.toContain(plaintext)

    await expect(gateway.tokenStatus()).resolves.toMatchObject({ maskedHint: `ghp_${DOTS}wxyz` })
    const cleared = await gateway.clearGitHubToken()
    expect('maskedHint' in cleared.status).toBe(false)
    expect(JSON.stringify(cleared)).not.toContain(plaintext)
  })

  it('carries the mask for an environment-supplied token too', async () => {
    const seam = new Seam()
    seam.env.set(HEAD, 'ghp_ENVCANARY0123456789abcdefwxyz')
    const gateway = gatewayOver(sourceWith(buildCredentialTokenPort(realCtx(seam))))
    const status = await gateway.tokenStatus()
    expect(status).toMatchObject({ configured: true, source: 'env', writable: false })
    expect(status.maskedHint).toBe(`ghp_${DOTS}wxyz`)
  })

  it('never lets the plaintext cross the HTTP envelope', async () => {
    const seam = new Seam()
    const gateway = gatewayOver(sourceWith(buildCredentialTokenPort(realCtx(seam))))
    const url = await serveChannel(gateway)
    const plaintext = 'ghp_HTTPCANARY0123456789abcdefXYZ9'

    const saved = await callChannel(url, 'saveGitHubToken', { value: plaintext })
    expect(saved.status).toBe(200)
    expect(saved.raw).not.toContain(plaintext)
    expect(saved.raw).toContain(`ghp_${DOTS}XYZ9`)
    expect((saved.value as { status: { maskedHint?: string } }).status.maskedHint).toBe(`ghp_${DOTS}XYZ9`)

    const status = await callChannel(url, 'tokenStatus', {})
    expect(status.raw).not.toContain(plaintext)
    expect(status.raw).toContain(`ghp_${DOTS}XYZ9`)

    // Refusals echo nothing either.
    const blank = await callChannel(url, 'saveGitHubToken', { value: '' })
    expect(blank.error?.code).toBe('github/bad-request')
    expect(blank.raw).not.toContain(plaintext)
    const badType = await callChannel(url, 'saveGitHubToken', { value: 42 })
    expect(badType.raw).not.toContain(plaintext)

    const cleared = await callChannel(url, 'clearGitHubToken', {})
    expect(cleared.raw).not.toContain(plaintext)
    expect(cleared.raw).not.toContain('maskedHint')
    expect(cleared.raw).not.toContain(String.fromCharCode(0x2022))
  })

  it('keeps the short-value protection across the wire', async () => {
    const seam = new Seam()
    const gateway = gatewayOver(sourceWith(buildCredentialTokenPort(realCtx(seam))))
    const url = await serveChannel(gateway)
    const answered = await callChannel(url, 'saveGitHubToken', { value: 'ghp_1234' })
    expect((answered.value as { status: { maskedHint?: string } }).status.maskedHint).toBe(DOTS)
    expect(answered.raw).not.toContain('ghp_1234')
  })
})

// ---------------------------------------------------------------------------
// D. The mask is host-only: the client bundle must not know it
// ---------------------------------------------------------------------------

describe('LIZHU probe D: the client carries the mask as data only', () => {
  const dot = String.fromCharCode(0x2022)

  it('reads the mask field without deriving, embedding or handling the plaintext', () => {
    const client = readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8')
    // The field NAME is wire vocabulary the consumer must know: the framework
    // directs the client mirror of `MarketTokenStatus` to carry `maskedHint`, so
    // the client reads it (exactly one site) and renders whatever the host sent.
    // What must never ship is the mask VOCABULARY: the client neither builds the
    // dot run nor derives anything from a value, and no plaintext reaches it.
    expect((client.split('maskedHint').length - 1)).toBe(1)
    expect(client).toContain('= token.maskedHint;')
    expect(client).not.toContain(dot)
    // No derivation shipped: the host-side mask helper is not in the client.
    expect(client).not.toContain('maskOf')
    // Sanity: the checks above are meaningful because the HOST bundle derives
    // the mask and therefore does carry both the field name and the dot run.
    const control = readFileSync(join(process.cwd(), 'lib', 'control.js'), 'utf8')
    expect(control).toContain('maskedHint')
    expect(control).toContain(dot)
  })
})
// ---------------------------------------------------------------------------
// E. The mask follows the EFFECTIVE reference (the fallback case)
// ---------------------------------------------------------------------------

describe('LIZHU probe E: the mask describes whichever reference is effective', () => {
  it('masks the fallback reference when only it is configured', async () => {
    const seam = new Seam()
    seam.store.set(FALLBACK, 'ghp_fallbackvalueWXYZ')
    const port = buildCredentialTokenPort(realCtx(seam))
    const status = (await port.status()).status
    expect(status).toMatchObject({ configured: true, source: 'file', ref: FALLBACK })
    expect(status.maskedHint).toBe(`ghp_${DOTS}WXYZ`)

    // Preferring the head again changes which value is masked, per request.
    seam.store.set(HEAD, 'ghp_headvalue1234567890ABCD')
    const preferred = (await port.status()).status
    expect(preferred).toMatchObject({ ref: HEAD })
    expect(preferred.maskedHint).toBe(`ghp_${DOTS}ABCD`)
  })
})