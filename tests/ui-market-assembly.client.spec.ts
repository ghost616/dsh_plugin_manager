/**
 * Assembly spec of the plugin-market browser half: a real Cordis Context with
 * functional replicas of the platform slot/locale runtimes (the dsh platform
 * packages are module-table rows of the shipped web shell, not installed
 * here), plus a stubbed fetch acting as the control web channel.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MARKET_CONTROL_WEB_PATH, MarketCallFailure } from '../src/client/channel.ts'
import { apply, inject, NS } from '../src/client/index.ts'
import { ManagePluginsTab } from '../src/client/ManagePluginsTab.tsx'
import { en, zh } from '../src/client/locales.ts'
import {
  FakeLocaleRuntime,
  FakeSlotRegistry,
  makeInstallReview,
  makeList,
  makeRepositoryDetail,
  makeSearchPage,
  makeStatus,
  resolveSlotLabel,
  type FakeStoredEntry,
} from './support/client-platform.ts'

const contexts: Context[] = []
const registries: FakeSlotRegistry[] = []
const locales: FakeLocaleRuntime[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.disposeInjections()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

interface Bench {
  ctx: Context
  locale: FakeLocaleRuntime
  slots: FakeSlotRegistry
  /** Disposable plugin fiber of the UI contribution. */
  fiber: { dispose(): Promise<void> }
}

async function bench(): Promise<Bench> {
  const ctx = new Context()
  contexts.push(ctx)
  const locale = new FakeLocaleRuntime()
  locales.push(locale)
  const slots = new FakeSlotRegistry()
  registries.push(slots)
  ctx.provide('locale', locale)
  ctx.provide('slots', slots)
  const fiber = await ctx.plugin({ name: 'plugin-market-ui', inject, apply }).await()
  return { ctx, locale, slots, fiber }
}

/** Declare the settings-section slot like the settings shell does. */
function declareSection(slots: FakeSlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  }, () => null)
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Point the channel at a scripted fetch; returns the spy. */
function stubChannel(fetchMock: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('fetch', fetchMock)
}

type InjectedFace = {
  status: () => Promise<unknown>
  list: () => Promise<unknown>
  setEnabled: (key: string, enabled: boolean) => Promise<unknown>
  requestRemove: (key: string) => Promise<unknown>
  confirmRemove: (key: string, token: string) => Promise<unknown>
  search: (keywords: string, page: number) => Promise<unknown>
  repositoryDetail: (repository: string) => Promise<unknown>
  previewInstall: (repository: string, version?: string | null, refKind?: 'branch' | 'tag') => Promise<unknown>
  install: (repository: string, confirmToken: string, version?: string | null, refKind?: 'branch' | 'tag') => Promise<unknown>
}

function faceOf(entry: FakeStoredEntry): InjectedFace {
  return (entry.inject as () => InjectedFace)()
}

function sectionEntry(slots: FakeSlotRegistry): FakeStoredEntry {
  const entry = slots.entries('settings.section')[0]
  if (entry === undefined) throw new Error('no settings.section entry')
  return entry
}

describe('plugin-market browser half assembly', () => {
  it('declares exactly the services the contribution consumes', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the page as a localized settings section without touching the channel', async () => {
    const { slots } = await bench()
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, value: makeList([]) }))
    stubChannel(fetchMock)

    expect(slots.entries('settings.section')).toHaveLength(0)
    // The Plugins section keeps its own tabs: this plugin contributes none.
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(slots.pendingInjections()).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()

    const stop = declareSection(slots)
    const entry = sectionEntry(slots)
    expect(entry.component).toBe(ManagePluginsTab)
    expect(entry.options).toMatchObject({ id: 'market', order: 16 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe(zh.tab)
    expect(fetchMock).not.toHaveBeenCalled()

    const face = faceOf(entry)
    for (const member of [
      'status', 'list', 'setEnabled', 'requestRemove', 'confirmRemove',
      'search', 'repositoryDetail', 'previewInstall', 'install',
    ]) {
      expect(typeof (face as Record<string, unknown>)[member]).toBe('function')
    }

    stop()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })

  it('lazily maps every face member to its channel method on demand', async () => {
    const { slots } = await bench()
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, value: makeList([]) }))
    stubChannel(fetchMock)
    declareSection(slots)
    const face = faceOf(sectionEntry(slots))

    const pages = [
      { call: () => face.status(), method: 'status', args: {} },
      {
        call: () => face.search('agents', 2),
        method: 'search',
        args: { keywords: 'agents', perPage: 10, page: 2 },
      },
      {
        call: () => face.previewInstall('octocat/demo', 'v2.0.0', 'tag'),
        method: 'previewInstall',
        args: { repository: 'octocat/demo', version: 'v2.0.0', refKind: 'tag' },
      },
      {
        call: () => face.repositoryDetail('octocat/demo'),
        method: 'repositoryDetail',
        args: { repository: 'octocat/demo' },
      },
      {
        call: () => face.install('octocat/demo', 'tok', 'main', 'branch'),
        method: 'install',
        args: { repository: 'octocat/demo', confirmToken: 'tok', version: 'main', refKind: 'branch' },
      },
    ]
    for (const page of pages) {
      await page.call()
      const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
      expect(url).toBe(MARKET_CONTROL_WEB_PATH)
      expect(JSON.parse(String(init.body))).toMatchObject({ method: page.method, args: page.args })
    }
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('omits refKind from the wire when a legacy review/install is requested', async () => {
    const { slots } = await bench()
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, value: makeInstallReview({ repository: 'octocat/demo' }) }))
    stubChannel(fetchMock)
    declareSection(slots)
    const face = faceOf(sectionEntry(slots))

    await face.previewInstall('octocat/demo', 'v2.0.0')
    await face.install('octocat/demo', 'tok', 'main')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Legacy calls never serialize a refKind key: the host treats the absence
    // as the pre-v2 default-branch review/install.
    const preview = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(preview[1].body))).toEqual({
      method: 'previewInstall',
      args: { repository: 'octocat/demo', version: 'v2.0.0' },
    })
    const installCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(String(installCall[1].body))).toEqual({
      method: 'install',
      args: { repository: 'octocat/demo', confirmToken: 'tok', version: 'main' },
    })
  })

  it('translates wire failures into typed failures with the carrier code', async () => {
    const { slots } = await bench()
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: false,
      error: { code: 'github/rate-limit', message: 'limited', details: {} },
    }))
    stubChannel(fetchMock)
    declareSection(slots)
    const face = faceOf(sectionEntry(slots))

    const error = await face.search('agents', 1).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MarketCallFailure)
    expect(error as MarketCallFailure).toMatchObject({ code: 'github/rate-limit', message: 'limited' })
  })

  it('normalizes a transport failure to the market/unreachable code', async () => {
    const { slots } = await bench()
    const fetchMock = vi.fn(async () => { throw new TypeError('network down') })
    stubChannel(fetchMock)
    declareSection(slots)

    const face = faceOf(sectionEntry(slots))
    const error = await face.install('octocat/demo', 'tok', null, undefined).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MarketCallFailure)
    expect(error as MarketCallFailure).toMatchObject({ code: 'market/unreachable' })
  })

  it('passes decoded values through to the lazy closures', async () => {
    const { slots } = await bench()
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      if (body.method === 'status') return jsonResponse({ ok: true, value: makeStatus(false) })
      if (body.method === 'repositoryDetail') {
        return jsonResponse({ ok: true, value: makeRepositoryDetail({ repository: 'octocat/demo', tags: ['v1.0.0'] }) })
      }
      return jsonResponse({ ok: true, value: makeSearchPage([{ repository: 'octocat/demo', name: 'demo' }]) })
    })
    stubChannel(fetchMock)
    declareSection(slots)
    const face = faceOf(sectionEntry(slots))

    await expect(face.status()).resolves.toEqual(makeStatus(false))
    await expect(face.search('demo', 1)).resolves.toMatchObject({ totalCount: 1 })
    await expect(face.repositoryDetail('octocat/demo')).resolves.toMatchObject({
      repository: 'octocat/demo',
      defaultBranch: 'main',
      tags: ['v1.0.0'],
    })
    void fetchMock
  })

  it('follows locale switches and recovers across declaration collapse and remount', async () => {
    const { slots, locale } = await bench()
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, value: makeList([]) }))
    stubChannel(fetchMock)

    expect(slots.entries('settings.section')).toHaveLength(0)
    const stop = declareSection(slots)
    expect(resolveSlotLabel(sectionEntry(slots).options.label)).toBe(zh.tab)

    locale.setLocale('en')
    expect(resolveSlotLabel(sectionEntry(slots).options.label)).toBe(en.tab)

    stop()
    expect(slots.entries('settings.section')).toHaveLength(0)
    declareSection(slots)
    const remounted = sectionEntry(slots)
    expect(remounted.component).toBe(ManagePluginsTab)
    expect(remounted.options).toMatchObject({ id: 'market', order: 16 })
    expect(resolveSlotLabel(remounted.options.label)).toBe(en.tab)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('tears the contribution down with the fiber and releases its dictionaries', async () => {
    const { slots, locale, ctx, fiber } = await bench()
    declareSection(slots)
    expect(slots.entries('settings.section')).toHaveLength(1)

    await fiber.dispose()
    // The fiber unload collects the slots.inject wait; the locale dictionary
    // effect unregisters its namespace (a later registration must not throw).
    slots.disposeInjections()
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(locale.resolve(NS, 'tab')).toBe('tab')
    expect(() => locale.register(NS, { zh, en })).not.toThrow()
    await ctx.fiber.dispose()
  })
})
