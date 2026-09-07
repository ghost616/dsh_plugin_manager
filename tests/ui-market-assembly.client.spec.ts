/**
 * Assembly spec of the plugin-market browser half: a real Cordis Context with
 * functional replicas of the platform slot/locale runtimes (the dsh platform
 * packages are module-table rows of the shipped web shell, not installed
 * here), plus a stubbed fetch acting as the control web channel.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPluginList, PluginMarketRecord } from '../src/types.ts'
import { MARKET_CONTROL_WEB_PATH, MarketCallFailure } from '../src/client/channel.ts'
import { apply, inject, NS } from '../src/client/index.ts'
import { ManagePluginsTab } from '../src/client/ManagePluginsTab.tsx'
import {
  FakeLocaleRuntime,
  FakeSlotRegistry,
  makeList,
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

/** Declare the tab slot like the Plugins section entry does. */
function declareTab(slots: FakeSlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
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
  list: () => Promise<ManagedPluginList>
  setEnabled: (key: string, enabled: boolean) => Promise<PluginMarketRecord>
}

function faceOf(entry: FakeStoredEntry): InjectedFace {
  const face = (entry.inject as (() => InjectedFace))()
  return face
}

function tabEntry(slots: FakeSlotRegistry): FakeStoredEntry {
  const entry = slots.entries('settings.plugins.tab')[0]
  if (entry === undefined) throw new Error('no settings.plugins.tab entry')
  return entry
}

describe('plugin-market browser half assembly', () => {
  it('declares exactly the services the contribution consumes', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the localized tab behind the declaration without touching the channel', async () => {
    const { slots, locale } = await bench()
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, value: makeList([]) }))
    stubChannel(fetchMock)

    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(slots.pendingInjections()).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()

    const stop = declareTab(slots)
    const entry = tabEntry(slots)
    expect(entry.component).toBe(ManagePluginsTab)
    expect(entry.options).toMatchObject({ id: 'market', order: 20 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('插件管理')
    expect(fetchMock).not.toHaveBeenCalled()

    const face = faceOf(entry)
    expect(typeof face.list).toBe('function')
    expect(typeof face.setEnabled).toBe('function')

    const value = makeList([
      { key: 'gh-octo-demo', repository: 'octocat/demo-plugin', enabled: true },
    ])
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, value }))
    await expect(face.list()).resolves.toEqual(value)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(MARKET_CONTROL_WEB_PATH)
    expect(JSON.parse(String(init.body))).toMatchObject({ method: 'listManaged', args: {} })
    expect(fetchMock).not.toHaveBeenCalledTimes(2)

    stop()
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
  })

  it('translates a wire failure into a typed MarketCallFailure with the carrier code', async () => {
    const { slots } = await bench()
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: false,
      error: { code: 'market/protected', message: 'protected entry', details: { key: 'gh-x' } },
    }))
    stubChannel(fetchMock)
    declareTab(slots)

    const face = faceOf(tabEntry(slots))
    const error = await face.list().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MarketCallFailure)
    expect(error).toMatchObject({ code: 'market/protected', message: 'protected entry' })
  })

  it('normalizes a transport failure to the market/unreachable code', async () => {
    const { slots } = await bench()
    const fetchMock = vi.fn(async () => { throw new TypeError('network down') })
    stubChannel(fetchMock)
    declareTab(slots)

    const face = faceOf(tabEntry(slots))
    const error = await face.setEnabled('gh-x', true).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MarketCallFailure)
    expect(error).toMatchObject({ code: 'market/unreachable' })
  })

  it('follows locale switches and recovers across declaration collapse and remount', async () => {
    const { slots, locale } = await bench()
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, value: makeList([]) }))
    stubChannel(fetchMock)

    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
    const stop = declareTab(slots)
    expect(resolveSlotLabel(tabEntry(slots).options.label)).toBe('插件管理')

    locale.setLocale('en')
    expect(resolveSlotLabel(tabEntry(slots).options.label)).toBe('Managed plugins')

    stop()
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
    declareTab(slots)
    const remounted = tabEntry(slots)
    expect(remounted.component).toBe(ManagePluginsTab)
    expect(remounted.options).toMatchObject({ id: 'market', order: 20 })
    expect(resolveSlotLabel(remounted.options.label)).toBe('Managed plugins')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('tears the contribution down with the fiber and releases its dictionaries', async () => {
    const { slots, locale, ctx, fiber } = await bench()
    declareTab(slots)
    expect(slots.entries('settings.plugins.tab')).toHaveLength(1)

    await fiber.dispose()
    // The fiber unload collects the slots.inject wait; the locale dictionary
    // effect unregisters its namespace (a later registration must not throw).
    slots.disposeInjections()
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(locale.resolve(NS, 'tab')).toBe('tab')
    expect(() => locale.register(NS, { zh: { tab: '插件管理' }, en: { tab: 'Managed plugins' } })).not.toThrow()
    await ctx.fiber.dispose()
  })
})


