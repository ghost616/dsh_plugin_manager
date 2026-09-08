// @vitest-environment jsdom
/**
 * Component spec of the GitHub browse modal and the full managed-plugins
 * page: open button, in-dialog search, pagination, installed markers,
 * install entry, states, and close/unmount hygiene.
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
  makeSearchPage,
  makeStatus,
  managePageHarness,
  type SearchItemSeed,
} from './support/client-platform.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => { root.unmount() })
  }
  document.body.innerHTML = ''
  vi.restoreAllMocks()
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

function pageOf(page: number, items: SearchItemSeed[], totalCount: number) {
  const pageData = makeSearchPage(items)
  return { totalCount, items: pageData.items }
}

async function openMarket(host: HTMLElement): Promise<HTMLElement> {
  await click(host.querySelector('[data-open-market]'))
  await flush()
  const dialog = host.querySelector('[data-dialog="market"]') as HTMLElement | null
  if (dialog === null) throw new Error('market dialog did not open')
  return dialog
}

async function searchIn(dialog: HTMLElement, keywords: string): Promise<void> {
  const input = dialog.querySelector<HTMLInputElement>('[data-market-search-input]')!
  await typeInto(input, keywords)
  submitForm(input)
  await flush()
}

describe('ManagePluginsTab GitHub browse modal', () => {
  it('hides the browse button while the market is idle', async () => {
    const { props } = managePageHarness({ status: vi.fn(async () => makeStatus(false)) })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    expect(host.querySelector('[data-open-market]')).toBeNull()
    expect(host.querySelector('[data-market-status="idle"]')).not.toBeNull()
  })

  it('opens the modal with the browse button, auto-browses once, and closes it again', async () => {
    const { props, mocks } = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const dialog = await openMarket(host)
    expect(dialog.textContent).toContain(zh.marketDialogTitle)
    // On mount with an empty box the dialog browses all dsh plugins once
    // (empty keyword); the default mock returns no hits.
    expect(mocks.search).toHaveBeenCalledTimes(1)
    expect(mocks.search).toHaveBeenCalledWith('', 1)
    expect(dialog.querySelector('[data-market-empty]')).not.toBeNull()

    await click(dialog.querySelector('[data-market-close]'))
    expect(host.querySelector('[data-dialog="market"]')).toBeNull()
  })

  it('searches inside the dialog and renders result cards', async () => {
    const search = vi.fn(async (_keywords: string, page: number) => pageOf(page, [
      {
        repository: 'octocat/demo-plugin',
        name: 'demo-plugin',
        description: 'a dsh plugin',
        stars: 12,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ], 1))
    const { props, mocks } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)

    await searchIn(dialog, 'agents')
    expect(search).toHaveBeenCalledWith('agents', 1)

    const card = dialog.querySelector('[data-market-card]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('demo-plugin')
    expect(card?.textContent).toContain('a dsh plugin')
    expect(card?.textContent).toContain(zh.starsLabel.replace('{count}', '12'))
    expect(card?.textContent).toContain(zh.updatedLabel.replace('{date}', '2026-01-01'))
    expect(card?.querySelector('[data-market-link]')?.getAttribute('href')).toContain('github.com')
    void mocks
  })

  it('paginates with fixed page size, page controls and the count line', async () => {
    const seed = (n: number): SearchItemSeed[] => Array.from({ length: 10 }, (_, i) => ({
      repository: `acme/plugin-${String((n - 1) * 10 + i + 1)}`,
      name: `plugin-${String((n - 1) * 10 + i + 1)}`,
    }))
    const search = vi.fn(async (_keywords: string, page: number) => pageOf(page, seed(page), 25))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)

    await searchIn(dialog, 'agents')
    let count = dialog.querySelector('[data-page-count]')
    expect(count?.textContent).toContain(zh.pagination
      .replace('{current}', '1').replace('{total}', '3').replace('{count}', '25'))
    const prev = dialog.querySelector('[data-page-prev]') as HTMLButtonElement
    const next = dialog.querySelector('[data-page-next]') as HTMLButtonElement
    expect(prev.disabled).toBe(true)
    expect(next.disabled).toBe(false)

    await click(next)
    expect(search).toHaveBeenLastCalledWith('agents', 2)
    count = dialog.querySelector('[data-page-count]')
    expect(count?.textContent).toContain(zh.pagination
      .replace('{current}', '2').replace('{total}', '3').replace('{count}', '25'))
    expect((dialog.querySelector('[data-page-prev]') as HTMLButtonElement).disabled).toBe(false)

    await click(dialog.querySelector('[data-page-prev]'))
    expect(search).toHaveBeenLastCalledWith('agents', 1)
  })

  it('shows empty and localized failure states of a search', async () => {
    const first = managePageHarness({ search: vi.fn(async () => makeSearchPage([])) })
    const host = await renderInto(<ManagePluginsTab {...first.props} />)
    await flush()
    let dialog = await openMarket(host)
    await searchIn(dialog, 'zzz')
    expect(dialog.querySelector('[data-market-empty]')?.textContent).toContain(zh.searchEmpty)
    const root1 = roots.pop()!
    await act(async () => { root1.unmount() })
    host.remove()

    const limited = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'github/rate-limit', message: 'limited', details: {} })
    })
    const second = managePageHarness({ search: limited })
    const host2 = await renderInto(<ManagePluginsTab {...second.props} />)
    await flush()
    dialog = await openMarket(host2)
    await searchIn(dialog, 'agents')
    const error = dialog.querySelector('[data-market-error]')
    expect(error).not.toBeNull()
    expect(error?.getAttribute('data-error-code')).toBe('github/rate-limit')
    expect(error?.textContent).toContain(zh.rateLimited)

    const down = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'market/unreachable', message: 'down', details: {} })
    })
    const third = managePageHarness({ search: down })
    const host3 = await renderInto(<ManagePluginsTab {...third.props} />)
    await flush()
    dialog = await openMarket(host3)
    await searchIn(dialog, 'agents')
    expect(dialog.querySelector('[data-market-error]')?.textContent).toContain(zh.networkError)
  })
})
describe('ManagePluginsTab GitHub browse modal interactions', () => {
  it('marks installed rows with a badge and disables their install action', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-octocat-demo-plugin', repository: 'octocat/demo-plugin', enabled: false },
    ]))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'octocat/demo-plugin', name: 'demo-plugin' },
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ list, search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'plugins')

    const cards = dialog.querySelectorAll('[data-market-card]')
    const installed = cards[0]!
    expect(installed.getAttribute('data-repository')).toBe('octocat/demo-plugin')
    expect(installed.querySelector('[data-installed]')?.textContent).toContain(zh.installedBadge)
    expect((installed.querySelector('[data-install-trigger]') as HTMLButtonElement).disabled).toBe(true)

    const fresh = cards[1]!
    expect(fresh.querySelector('[data-installed]')).toBeNull()
    expect((fresh.querySelector('[data-install-trigger]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('installs a fresh result through the two-step preview flow and re-marks it', async () => {
    let snapshot = makeList([])
    const list = vi.fn(async () => snapshot)
    const previewInstall = vi.fn(async (repository: string) => makeInstallReview({ repository }))
    const install = vi.fn(async (repository: string) => {
      snapshot = makeList([{ key: `gh-${repository.replace('/', '-')}`, repository, enabled: false }])
      return makeInstallOutcome({ repository })
    })
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ list, search, previewInstall, install })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')

    await click(dialog.querySelector('[data-install-trigger]'))
    await flush()
    const installDialog = dialog.querySelector('[data-dialog="install"]')
    expect(installDialog).not.toBeNull()
    expect(previewInstall).toHaveBeenCalledWith('acme/helper')

    await click(installDialog?.querySelector('[data-install-confirm]'))
    await flush()
    expect(install).toHaveBeenCalledWith('acme/helper', 'token-acme/helper')
    await click(installDialog?.querySelector('[data-dialog-done]'))
    await flush()
    expect(dialog.querySelector('[data-dialog="install"]')).toBeNull()

    // The page reloaded the roster; the result row now carries the badge.
    const card = dialog.querySelector('[data-market-card]')
    expect(card?.querySelector('[data-installed]')?.textContent).toContain(zh.installedBadge)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('shows overwrite and degraded notices when the preview reports them', async () => {
    const previewInstall = vi.fn(async (repository: string) => makeInstallReview({
      repository,
      exists: true,
      degraded: true,
      dependencies: [],
      peerDependencies: [],
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, previewInstall })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')

    await click(dialog.querySelector('[data-install-trigger]'))
    await flush()
    const installDialog = dialog.querySelector('[data-dialog="install"]')
    expect(installDialog?.querySelector('[data-overwrite-notice]')).not.toBeNull()
    const degraded = installDialog?.querySelector('[data-degraded-notice]')
    expect(degraded?.getAttribute('data-degraded-code')).toBe('github/bad-response')
    expect(degraded?.textContent).toContain(zh.degradedNotice.replace('{code}', 'github/bad-response'))
  })

  it('keeps the install dialog open on an expired confirmation and offers re-preview', async () => {
    const previewInstall = vi.fn(async (repository: string) => makeInstallReview({ repository }))
    const install = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'market/confirm-expired', message: 'expired', details: {} })
    })
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, previewInstall, install })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')

    await click(dialog.querySelector('[data-install-trigger]'))
    await flush()
    await click(dialog.querySelector('[data-install-confirm]'))
    await flush()
    const error = dialog.querySelector('[data-install-error]')
    expect(error).not.toBeNull()
    expect(error?.getAttribute('data-error-code')).toBe('market/confirm-expired')
    expect(error?.textContent).toContain(zh.confirmExpired)
    expect(dialog.querySelector('[data-repreview]')).not.toBeNull()
  })

  it('ignores a late search result after the modal closes', async () => {
    let settle: (page: unknown) => void = () => {}
    const search = vi.fn(() => new Promise(resolve => { settle = resolve }))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'agents')

    await click(dialog.querySelector('[data-market-close]'))
    await act(async () => {
      settle(makeSearchPage([{ repository: 'acme/helper', name: 'helper' }]))
    })
    await flush()
    expect(host.querySelector('[data-dialog="market"]')).toBeNull()
    expect(host.textContent).not.toContain('helper')
  })

  it('keeps the newest keywords when an older request resolves late', async () => {
    let settleOld: (page: unknown) => void = () => {}
    const search = vi.fn((keywords: string) => {
      if (keywords === 'old') {
        return new Promise(resolve => { settleOld = resolve })
      }
      return Promise.resolve(makeSearchPage([
        { repository: `acme/${keywords}`, name: keywords },
      ]))
    })
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)

    const input = dialog.querySelector<HTMLInputElement>('[data-market-search-input]')!
    await typeInto(input, 'old')
    submitForm(input)
    await typeInto(input, 'new')
    submitForm(input)
    await flush()

    const card = dialog.querySelector('[data-market-card]')
    expect(card?.getAttribute('data-repository')).toBe('acme/new')

    await act(async () => {
      settleOld(makeSearchPage([{ repository: 'acme/old', name: 'old' }]))
    })
    await flush()
    const after = dialog.querySelector('[data-market-card]')
    expect(after?.getAttribute('data-repository')).toBe('acme/new')
  })
})
describe('ManagePluginsTab GitHub modal drag & close affordances', () => {
  function dragRect(left: number, top: number, width: number, height: number): DOMRect {
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as unknown as DOMRect
  }

  /** Dispatch one synthetic mouse event on a target inside act(). */
  async function mouse(where: EventTarget, type: string, x: number, y: number): Promise<void> {
    await act(async () => {
      where.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY: y,
      }))
    })
  }

  it('exposes the title bar as a drag handle and moves the dialog with the pointer', async () => {
    const { props } = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)

    const handle = dialog.querySelector('[data-drag-handle]')
    expect(handle).not.toBeNull()

    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(dragRect(400, 250, 560, 400))
    try {
      await mouse(handle!, 'mousedown', 420, 280)
      await mouse(window, 'mousemove', 470, 340)
      expect(dialog.style.position).toBe('fixed')
      expect(dialog.style.left).toBe('450px')
      expect(dialog.style.top).toBe('310px')

      // Release keeps the dragged origin (the dialog remembers its spot).
      await mouse(window, 'mouseup', 470, 340)
      expect(dialog.style.left).toBe('450px')
    } finally {
      spy.mockRestore()
    }
  })

  it('clamps the dragged dialog inside the viewport', async () => {
    const { props } = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)

    const handle = dialog.querySelector('[data-drag-handle]')!
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(dragRect(100, 100, 560, 400))
    try {
      await mouse(handle, 'mousedown', 120, 120)
      // Far beyond the bottom-right corner: clamped to the viewport inset.
      await mouse(window, 'mousemove', window.innerWidth + 10_000, window.innerHeight + 10_000)
      expect(dialog.style.left).toBe(`${window.innerWidth - 560 - 8}px`)
      expect(dialog.style.top).toBe(`${window.innerHeight - 400 - 8}px`)
      // Far beyond the top-left corner: clamped to the minimum edge inset.
      await mouse(window, 'mousemove', -10_000, -10_000)
      expect(dialog.style.left).toBe('8px')
      expect(dialog.style.top).toBe('8px')
      await mouse(window, 'mouseup', -10_000, -10_000)
    } finally {
      spy.mockRestore()
    }
  })

  it('never starts a drag from the close button and close still works', async () => {
    const { props } = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)

    const close = dialog.querySelector('[data-market-close]')!
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(dragRect(400, 250, 560, 400))
    try {
      await mouse(close, 'mousedown', 400, 250)
      await mouse(window, 'mousemove', 800, 600)
      expect(dialog.style.position).toBe('')
    } finally {
      spy.mockRestore()
    }

    await click(dialog.querySelector('[data-market-close]'))
    expect(host.querySelector('[data-dialog="market"]')).toBeNull()
  })

  it('renders the dsh-chrome close button with a localized label and × glyph', async () => {
    const { props } = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)

    const close = dialog.querySelector('[data-market-close]')
    expect(close).not.toBeNull()
    expect(close?.getAttribute('aria-label')).toBe(zh.closeButton)
    expect(close?.getAttribute('type')).toBe('button')
    const glyph = close?.querySelector('svg')
    expect(glyph).not.toBeNull()
    expect(glyph?.getAttribute('aria-hidden')).toBe('true')
    expect(glyph?.getAttribute('viewBox')).toBe('0 0 16 16')
  })
})
describe('ManagePluginsTab GitHub modal auto browse & scroll zones', () => {
  it('browses once per mount when the search box is empty', async () => {
    const search = vi.fn(async (_keywords: string, _page: number) => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    let dialog = await openMarket(host)

    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('', 1)
    expect(dialog.querySelector('[data-market-loading]')).toBeNull()
    expect(dialog.querySelector('[data-market-results]')).not.toBeNull()
    expect(dialog.textContent).toContain('helper')

    // Closing and reopening mounts a fresh dialog, which browses once again.
    await click(dialog.querySelector('[data-market-close]'))
    dialog = await openMarket(host)
    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenLastCalledWith('', 1)
    expect(dialog.querySelector('[data-market-results]')).not.toBeNull()
  })

  it('does not auto re-browse when the box is cleared after a manual search', async () => {
    const search = vi.fn(async (_keywords: string, page: number) => makeSearchPage([
      { repository: `acme/p${String(page)}`, name: `p${String(page)}` },
    ]))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    expect(search).toHaveBeenCalledTimes(1)

    const input = dialog.querySelector<HTMLInputElement>('[data-market-search-input]')!
    await typeInto(input, 'agents')
    submitForm(input)
    await flush()
    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenLastCalledWith('agents', 1)

    // Clearing must not resubmit: previous results stay and no call is added.
    await typeInto(input, '')
    await flush()
    expect(search).toHaveBeenCalledTimes(2)
    expect(dialog.querySelector('[data-market-card]')).not.toBeNull()
  })

  it('localizes and retries a mount auto-browse failure', async () => {
    const search = vi.fn()
      .mockRejectedValueOnce(new MarketCallFailure({
        code: 'github/rate-limit',
        message: 'limited',
        details: {},
      }))
      .mockResolvedValueOnce(makeSearchPage([{ repository: 'acme/helper', name: 'helper' }]))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)

    const error = dialog.querySelector('[data-market-error]')
    expect(error).not.toBeNull()
    expect(error?.getAttribute('data-error-code')).toBe('github/rate-limit')
    expect(error?.textContent).toContain(zh.rateLimited)

    await click(dialog.querySelector('[data-market-retry]'))
    await flush()
    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenLastCalledWith('', 1)
    expect(dialog.querySelector('[data-market-error]')).toBeNull()
    expect(dialog.querySelector('[data-market-card]')).not.toBeNull()
  })

  it('keeps the search header and pagination outside the scrolling result zone', async () => {
    const seed = Array.from({ length: 10 }, (_, index) => ({
      repository: `acme/plugin-${String(index + 1)}`,
      name: `plugin-${String(index + 1)}`,
    }))
    const search = vi.fn(async (_keywords: string, page: number) => pageOf(page, seed, 25))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)

    const scrollZone = dialog.querySelector('[data-market-scroll]')
    expect(scrollZone).not.toBeNull()
    expect(scrollZone?.querySelector('[data-market-results]')).not.toBeNull()
    expect(scrollZone?.querySelector('[data-market-search-input]')).toBeNull()
    const pagination = dialog.querySelector('[data-pagination]')
    expect(pagination).not.toBeNull()
    expect(scrollZone?.contains(pagination)).toBe(false)
    const form = dialog.querySelector('form')
    expect(scrollZone?.contains(form)).toBe(false)
  })
})

