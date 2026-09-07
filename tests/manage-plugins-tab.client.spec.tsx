// @vitest-environment jsdom
/**
 * Component spec of the managed-plugins tab: props-fed render tests over
 * visible behavior and states (no DOM-class/internal assertions). Visible
 * copy assertions compare against the zh dictionary constants so the spec
 * source stays ASCII and the assertions exercise the real dictionaries.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { ManagedPluginList, PluginMarketKey, PluginMarketRecord } from '../src/types.ts'
import { zh } from '../src/client/locales.ts'
import { MarketCallFailure } from '../src/client/channel.ts'
import { ManagePluginsTab } from '../src/client/ManagePluginsTab.tsx'
import { makeList, makeTranslator, makeView } from './support/client-platform.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const t = makeTranslator('zh')

const roots: Root[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => { root.unmount() })
  }
  document.body.innerHTML = ''
})

async function renderInto(node: ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => { root.render(node) })
  return host
}

async function flush(): Promise<void> {
  await act(async () => {})
}

async function click(element: Element): Promise<void> {
  await act(async () => { (element as HTMLButtonElement).click() })
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function rows(host: HTMLElement): NodeListOf<HTMLElement> {
  return host.querySelectorAll<HTMLElement>('[data-plugin-row]')
}

function toggles(host: HTMLElement): NodeListOf<HTMLButtonElement> {
  return host.querySelectorAll<HTMLButtonElement>('[data-plugin-toggle]')
}

describe('ManagePluginsTab', () => {
  it('shows loading, then renders the managed roster with states and switch arias', async () => {
    let settle: (value: ManagedPluginList) => void = () => {}
    const list = vi.fn(() => new Promise<ManagedPluginList>(resolve => { settle = resolve }))
    const host = await renderInto(<ManagePluginsTab list={list} setEnabled={vi.fn()} t={t} />)

    expect(host.querySelector('[role="status"]')?.textContent).toContain(zh.loading)
    expect(list).toHaveBeenCalledTimes(1)

    await act(async () => {
      settle(makeList([
        { key: 'gh-a', repository: 'octocat/demo-plugin', enabled: true },
        { key: 'gh-b', repository: 'acme/helper-plugin', enabled: false },
      ]))
    })
    await flush()

    expect(host.querySelector('[aria-busy="true"]')).toBeNull()
    expect(rows(host)).toHaveLength(2)
    expect(host.textContent).toContain('octocat/demo-plugin')
    expect(host.textContent).toContain('acme/helper-plugin')
    expect(host.textContent).toContain(zh.kindGithub)
    expect(host.textContent).toContain(zh.stateEnabled)
    expect(host.textContent).toContain(zh.stateDisabled)
    expect(host.textContent).toContain(`2 ${zh.countUnit}`)

    const first = rows(host)[0]!
    expect(first.getAttribute('data-plugin-key')).toBe('gh-a')
    expect(first.getAttribute('data-plugin-state')).toBe('enabled')
    const second = rows(host)[1]!
    expect(second.getAttribute('data-plugin-state')).toBe('disabled')

    const switches = toggles(host)
    expect(switches[0]!.getAttribute('aria-checked')).toBe('true')
    expect(switches[1]!.getAttribute('aria-checked')).toBe('false')
  })

  it('flags an enabled row whose loader fiber failed', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-broken', repository: 'acme/broken', enabled: true, phase: 'failed', lastError: 'boom' },
      { key: 'gh-idle', repository: 'acme/idle', enabled: false },
    ]))
    const host = await renderInto(<ManagePluginsTab list={list} setEnabled={vi.fn()} t={t} />)
    await flush()

    const broken = rows(host)[0]!
    expect(broken.getAttribute('data-failed')).toBe('true')
    expect(broken.getAttribute('data-phase')).toBe('failed')
    expect(broken.textContent).toContain(zh.stateFailed)
    const idle = rows(host)[1]!
    expect(idle.getAttribute('data-failed')).toBeNull()
    expect(idle.getAttribute('data-phase')).toBeNull()
  })

  it('shows the empty roster state', async () => {
    const list = vi.fn(async () => makeList([]))
    const host = await renderInto(<ManagePluginsTab list={list} setEnabled={vi.fn()} t={t} />)
    await flush()
    expect(host.textContent).toContain(zh.empty)
    expect(host.querySelectorAll('[data-plugin-row]')).toHaveLength(0)
  })

  it('filters rows and shows the empty-search state', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false },
      { key: 'gh-b', repository: 'acme/other-plugin', enabled: false },
    ]))
    const host = await renderInto(<ManagePluginsTab list={list} setEnabled={vi.fn()} t={t} />)
    await flush()

    const input = host.querySelector<HTMLInputElement>('[data-manage-filter]')!
    await typeInto(input, 'demo')
    expect(rows(host)).toHaveLength(1)
    expect(rows(host)[0]?.getAttribute('data-plugin-key')).toBe('gh-a')

    await typeInto(input, 'zzz')
    expect(rows(host)).toHaveLength(0)
    expect(host.textContent).toContain(zh.emptySearch)

    await typeInto(input, '')
    expect(rows(host)).toHaveLength(2)
  })

  it('converges load failures into the error state and heals on retry', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new MarketCallFailure({
        code: 'market/unreachable',
        message: 'network down',
        details: {},
      }))
      .mockResolvedValueOnce(makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }]))
    const host = await renderInto(<ManagePluginsTab list={list} setEnabled={vi.fn()} t={t} />)
    await flush()

    const failure = host.querySelector('[data-list-error]')
    expect(failure).not.toBeNull()
    expect(failure?.getAttribute('data-error-code')).toBe('market/unreachable')
    expect(host.textContent).toContain(zh.error)

    const retry = host.querySelector<HTMLButtonElement>('button')
    expect(retry).not.toBeNull()
    await click(retry!)
    await flush()

    expect(host.querySelector('[data-list-error]')).toBeNull()
    expect(rows(host)).toHaveLength(1)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('applies a successful toggle and resyncs the roster', async () => {
    let state = makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }])
    const list = vi.fn(async () => state)
    const setEnabled = vi.fn(async (_key: PluginMarketKey, enabled: boolean): Promise<PluginMarketRecord> => {
      const entry = state.entries[0]!
      const record: PluginMarketRecord = { ...entry.record, enabled }
      state = { entries: [{ ...entry, record }] }
      return record
    })
    const host = await renderInto(<ManagePluginsTab list={list} setEnabled={setEnabled} t={t} />)
    await flush()

    const toggle = toggles(host)[0]!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    await flush()

    expect(setEnabled).toHaveBeenCalledWith('gh-a', true)
    expect(list).toHaveBeenCalledTimes(2)
    const updated = rows(host)[0]!
    expect(updated.getAttribute('data-plugin-state')).toBe('enabled')
    expect(toggles(host)[0]!.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the previous state and surfaces an inline failure when a toggle fails', async () => {
    const list = vi.fn(async () => makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }]))
    const setEnabled = vi.fn(async () => {
      throw new MarketCallFailure({
        code: 'market/protected',
        message: 'protected entry',
        details: { key: 'gh-a' },
      })
    })
    const host = await renderInto(<ManagePluginsTab list={list} setEnabled={setEnabled} t={t} />)
    await flush()

    const toggle = toggles(host)[0]!
    await click(toggle)
    await flush()

    expect(setEnabled).toHaveBeenCalledTimes(1)
    expect(rows(host)[0]!.getAttribute('data-plugin-state')).toBe('disabled')
    expect(toggles(host)[0]!.getAttribute('aria-checked')).toBe('false')
    const failure = host.querySelector('[data-toggle-error]')
    expect(failure).not.toBeNull()
    expect(failure?.getAttribute('data-error-code')).toBe('market/protected')
    expect(failure?.textContent).toContain('market/protected')
  })

  it('holds the switch busy while a toggle is in flight', async () => {
    let settleToggle: () => void = () => {}
    let snapshot = makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }])
    const list = vi.fn(async () => snapshot)
    const setEnabled = vi.fn(() => new Promise<PluginMarketRecord>(resolve => {
      settleToggle = () => {
        const entry = makeView({ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: true })
        snapshot = { entries: [{ ...snapshot.entries[0]!, record: entry.record }] }
        resolve(entry.record)
      }
    }))
    const host = await renderInto(<ManagePluginsTab list={list} setEnabled={setEnabled} t={t} />)
    await flush()

    const toggle = toggles(host)[0]!
    await click(toggle)
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('aria-busy')).toBe('true')

    await act(async () => { settleToggle() })
    await flush()
    expect(toggles(host)[0]!.disabled).toBe(false)
    expect(toggles(host)[0]!.getAttribute('aria-checked')).toBe('true')
  })

  it('ignores a late list result after unmount', async () => {
    let settle: (value: ManagedPluginList) => void = () => {}
    const list = vi.fn(() => new Promise<ManagedPluginList>(resolve => { settle = resolve }))
    const host = await renderInto(<ManagePluginsTab list={list} setEnabled={vi.fn()} t={t} />)

    const root = roots.pop()!
    await act(async () => { root.unmount() })
    await act(async () => {
      settle(makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }]))
    })
    await flush()
    expect(host.textContent).toBe('')
    host.remove()
  })

  it('ignores a late toggle result after unmount', async () => {
    let settleToggle: () => void = () => {}
    const list = vi.fn(async () => makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }]))
    const setEnabled = vi.fn(() => new Promise<PluginMarketRecord>(resolve => {
      settleToggle = () => {
        const entry = makeView({ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: true })
        resolve(entry.record)
      }
    }))
    const host = await renderInto(<ManagePluginsTab list={list} setEnabled={setEnabled} t={t} />)
    await flush()

    const toggle = toggles(host)[0]!
    await click(toggle)
    const root = roots.pop()!
    await act(async () => { root.unmount() })
    await act(async () => { settleToggle() })
    await flush()
    expect(host.textContent).toBe('')
    expect(list).toHaveBeenCalledTimes(1)
    host.remove()
  })
})


