// @vitest-environment jsdom
/**
 * Component spec of the plugin-market page M1 interactions: repository
 * status header, GitHub search, install confirmation dialog, and the
 * two-step removal flow.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { zh } from '../src/client/locales.ts'
import { MarketCallFailure } from '../src/client/channel.ts'
import { ManagePluginsTab } from '../src/client/ManagePluginsTab.tsx'
import {
  makeInstallOutcome,
  makeInstallReview,
  makeList,
  makeRemoveRequest,
  makeSearchPage,
  makeStatus,
  managePageHarness,
} from './support/client-platform.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

async function click(element: Element | null | undefined): Promise<void> {
  if (element === null || element === undefined) throw new Error('click target missing')
  await act(async () => { (element as HTMLButtonElement).click() })
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submitForm(input: HTMLInputElement): void {
  act(() => { input.form?.requestSubmit() })
}

function rows(host: HTMLElement): NodeListOf<HTMLElement> {
  return host.querySelectorAll<HTMLElement>('[data-plugin-row]')
}

describe('ManagePluginsTab market page', () => {
  it('shows the idle guidance when no repository is configured', async () => {
    const { props } = managePageHarness({ status: vi.fn(async () => makeStatus(false)) })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const idle = host.querySelector('[data-market-status="idle"]')
    expect(idle).not.toBeNull()
    expect(idle?.textContent).toContain(zh.idleTitle)
    expect(host.textContent).toContain(zh.idleBody)
    expect(host.querySelector('[data-search-section]')).toBeNull()
    expect(host.querySelector('[data-managed-heading]')).toBeNull()
  })

  it('recovers from a status transport error via retry', async () => {
    const status = vi.fn()
      .mockRejectedValueOnce(new MarketCallFailure({ code: 'market/unreachable', message: 'down', details: {} }))
      .mockResolvedValueOnce(makeStatus(true))
    const { props } = managePageHarness({ status })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const error = host.querySelector('[data-market-status-error]')
    expect(error).not.toBeNull()
    expect(error?.getAttribute('data-error-code')).toBe('market/unreachable')
    expect(host.textContent).toContain(zh.networkError)

    await click(error?.querySelector('button'))
    await flush()
    expect(host.querySelector('[data-market-status="configured"]')).not.toBeNull()
  })

  it('runs a search and renders the result cards', async () => {
    const search = vi.fn(async () => makeSearchPage([
      {
        repository: 'octocat/demo-plugin',
        name: 'demo-plugin',
        description: 'a dsh plugin',
        stars: 12,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      { repository: 'acme/helper', name: 'helper', stars: 3 },
    ]))
    const { props, mocks } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const input = host.querySelector<HTMLInputElement>('[data-search-input]')!
    await typeInto(input, 'agents')
    await submitForm(input)
    await flush()
    expect(search).toHaveBeenCalledWith('agents')

    const cards = host.querySelectorAll('[data-result-card]')
    expect(cards).toHaveLength(2)
    const first = cards[0]!
    expect(first.getAttribute('data-repository')).toBe('octocat/demo-plugin')
    expect(first.textContent).toContain('demo-plugin')
    expect(first.textContent).toContain('a dsh plugin')
    expect(first.textContent).toContain(zh.starsLabel.replace('{count}', '12'))
    expect(first.textContent).toContain(zh.updatedLabel.replace('{date}', '2026-01-01'))
    expect(first.querySelector('[data-result-link]')?.getAttribute('href')).toContain('github.com')
    expect(first.querySelector('[data-install-trigger]')?.textContent).toContain(zh.installButton)
    expect(mocks.list).toHaveBeenCalled()
  })

  it('shows the empty and failure states of a search', async () => {
    const { props, mocks } = managePageHarness({ search: vi.fn(async () => makeSearchPage([])) })
    let host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const input = host.querySelector<HTMLInputElement>('[data-search-input]')!
    await typeInto(input, 'zzz')
    await submitForm(input)
    await flush()
    expect(host.querySelector('[data-search-empty]')?.textContent).toContain(zh.searchEmpty)
    const root1 = roots.pop()!
    await act(async () => { root1.unmount() })
    host.remove()

    const search = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'github/rate-limit', message: 'limited', details: {} })
    })
    const harness = managePageHarness({ search })
    host = await renderInto(<ManagePluginsTab {...harness.props} />)
    await flush()
    const input2 = host.querySelector<HTMLInputElement>('[data-search-input]')!
    await typeInto(input2, 'agents')
    await submitForm(input2)
    await flush()
    const error = host.querySelector('[data-search-error]')
    expect(error).not.toBeNull()
    expect(error?.getAttribute('data-error-code')).toBe('github/rate-limit')
    expect(error?.textContent).toContain(zh.rateLimited)
    void mocks
  })

  it('marks an already-managed result and offers the update action', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-octocat-demo-plugin', repository: 'octocat/demo-plugin', enabled: false },
    ]))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'octocat/demo-plugin', name: 'demo-plugin' },
    ]))
    const { props } = managePageHarness({ list, search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    expect(rows(host)).toHaveLength(1)

    const input = host.querySelector<HTMLInputElement>('[data-search-input]')!
    await typeInto(input, 'demo')
    await submitForm(input)
    await flush()
    await flush()

    const card = host.querySelector('[data-result-card]')!
    const trigger = card?.querySelector('[data-install-trigger]')
    expect(trigger?.getAttribute('data-managed')).toBe('true')
    expect(trigger?.textContent).toContain(zh.updateButton)
  })

  it('opens the install dialog, shows declared dependencies, and installs on confirm', async () => {
    const list = vi.fn(async () => makeList([]))
    const previewInstall = vi.fn(async (repository: string) => makeInstallReview({
      repository,
      dependencies: ['@deepseek-ai/cordis', 'fast-xml-parser'],
      peerDependencies: ['react'],
    }))
    const install = vi.fn(async () => makeInstallOutcome({ repository: 'octocat/demo-plugin' }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'octocat/demo-plugin', name: 'demo-plugin' },
    ]))
    const { props } = managePageHarness({ list, search, previewInstall, install })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const input = host.querySelector<HTMLInputElement>('[data-search-input]')!
    await typeInto(input, 'demo')
    await submitForm(input)
    await flush()

    await click(host.querySelector('[data-install-trigger]'))
    await flush()
    expect(previewInstall).toHaveBeenCalledWith('octocat/demo-plugin')
    const dialog = host.querySelector('[data-dialog="install"]')
    expect(dialog).not.toBeNull()

    const deps = dialog?.querySelectorAll('[data-dep-list] li')
    expect(deps).toHaveLength(2)
    expect(dialog?.textContent).toContain('fast-xml-parser')
    expect(dialog?.querySelector('[data-peer-list] li')?.textContent).toContain('react')
    expect(dialog?.querySelector('[data-overwrite-notice]')).toBeNull()

    await click(dialog?.querySelector('[data-install-confirm]'))
    await flush()
    expect(install).toHaveBeenCalledWith('octocat/demo-plugin', 'token-octocat/demo-plugin')
    expect(dialog?.querySelector('[data-install-done]')?.textContent).toContain(zh.installDone)
    expect(list).toHaveBeenCalledTimes(2)

    await click(dialog?.querySelector('[data-dialog-done]'))
    expect(host.querySelector('[data-dialog="install"]')).toBeNull()
  })

  it('shows the overwrite notice and degraded dependencies for an existing plugin', async () => {
    const previewInstall = vi.fn(async (repository: string) => makeInstallReview({
      repository,
      exists: true,
      degraded: true,
      dependencies: [],
      peerDependencies: [],
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'octocat/demo-plugin', name: 'demo-plugin' },
    ]))
    const { props } = managePageHarness({
      list: vi.fn(async () => makeList([
        { key: 'gh-octocat-demo-plugin', repository: 'octocat/demo-plugin', enabled: false },
      ])),
      search,
      previewInstall,
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const input = host.querySelector<HTMLInputElement>('[data-search-input]')!
    await typeInto(input, 'demo')
    await submitForm(input)
    await flush()
    await click(host.querySelector('[data-install-trigger]'))
    await flush()

    const dialog = host.querySelector('[data-dialog="install"]')
    expect(dialog?.querySelector('[data-overwrite-notice]')).not.toBeNull()
    const degraded = dialog?.querySelector('[data-degraded-notice]')
    expect(degraded).not.toBeNull()
    expect(degraded?.getAttribute('data-degraded-code')).toBe('github/bad-response')
    expect(degraded?.textContent).toContain(zh.degradedNotice.replace('{code}', 'github/bad-response'))
  })

  it('surfaces install failures by code and keeps retry affordances', async () => {
    const previewInstall = vi.fn(async (repository: string) => makeInstallReview({ repository }))
    const install = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'market/confirm-expired', message: 'expired', details: {} })
    })
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'octocat/demo-plugin', name: 'demo-plugin' },
    ]))
    const { props } = managePageHarness({ search, previewInstall, install })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const input = host.querySelector<HTMLInputElement>('[data-search-input]')!
    await typeInto(input, 'demo')
    await submitForm(input)
    await flush()
    await click(host.querySelector('[data-install-trigger]'))
    await flush()
    const dialog = host.querySelector('[data-dialog="install"]')

    await click(dialog?.querySelector('[data-install-confirm]'))
    await flush()
    const error = dialog?.querySelector('[data-install-error]')
    expect(error).not.toBeNull()
    expect(error?.getAttribute('data-error-code')).toBe('market/confirm-expired')
    expect(error?.textContent).toContain(zh.confirmExpired)
    expect(dialog?.querySelector('[data-repreview]')).not.toBeNull()
  })

  it('removes a managed plugin through the two-step confirmation', async () => {
    let snapshot = makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }])
    const list = vi.fn(async () => snapshot)
    const requestRemove = vi.fn(async (key: string) => makeRemoveRequest(key, 'rm-token'))
    const confirmRemove = vi.fn(async (key: string) => {
      snapshot = makeList([])
      return { key, removedEntry: true, removedDirectory: true, removedRecord: true, directory: `/repo/${key}` }
    })
    const { props } = managePageHarness({ list, requestRemove, confirmRemove })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    await click(host.querySelector('[data-remove-trigger]'))
    const dialog = host.querySelector('[data-dialog="remove"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain(zh.removeStep1.replace('{name}', 'octocat/demo-plugin'))

    await click(dialog?.querySelector('[data-remove-continue]'))
    expect(requestRemove).toHaveBeenCalledWith('gh-a')
    expect(dialog?.querySelector('[data-remove-step2]')).not.toBeNull()

    await click(dialog?.querySelector('[data-remove-confirm]'))
    await flush()
    expect(confirmRemove).toHaveBeenCalledWith('gh-a', 'rm-token')
    expect(host.querySelector('[data-dialog="remove"]')).toBeNull()
    expect(rows(host)).toHaveLength(0)
  })

  it('keeps the removal dialog open with the failure code on errors', async () => {
    const list = vi.fn(async () => makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }]))
    const requestRemove = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'record/not-found', message: 'gone', details: {} })
    })
    const harness = managePageHarness({ list, requestRemove })
    const host = await renderInto(<ManagePluginsTab {...harness.props} />)
    await flush()

    await click(host.querySelector('[data-remove-trigger]'))
    await click(host.querySelector('[data-remove-continue]'))
    await flush()
    const dialog = host.querySelector('[data-dialog="remove"]')
    const error = dialog?.querySelector('[data-remove-error]')
    expect(error).not.toBeNull()
    expect(error?.getAttribute('data-error-code')).toBe('record/not-found')
    expect(dialog?.querySelector('[data-remove-step2]')).toBeNull()
    expect(dialog?.querySelector('[data-remove-continue]')).not.toBeNull()
  })

  it('stays on the second removal step when confirmRemove fails', async () => {
    const list = vi.fn(async () => makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }]))
    const requestRemove = vi.fn(async (key: string) => makeRemoveRequest(key, 'rm-token'))
    const confirmRemove = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'market/confirm-expired', message: 'expired', details: {} })
    })
    const { props } = managePageHarness({ list, requestRemove, confirmRemove })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    await click(host.querySelector('[data-remove-trigger]'))
    await click(host.querySelector('[data-remove-continue]'))
    await click(host.querySelector('[data-remove-confirm]'))
    await flush()

    const dialog = host.querySelector('[data-dialog="remove"]')
    const error = dialog?.querySelector('[data-remove-error]')
    expect(error?.getAttribute('data-error-code')).toBe('market/confirm-expired')
    expect(dialog?.querySelector('[data-remove-step2]')).not.toBeNull()
    expect(dialog?.querySelector('[data-remove-confirm]')).not.toBeNull()
  })
})






