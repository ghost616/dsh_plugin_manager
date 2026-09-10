// @vitest-environment jsdom
/**
 * Component spec of the GitHub tab of the plugin-market settings page:
 * the in-page tab switch, in-tab search, pagination, the height-adaptive
 * scroll contract, the repository detail view (merged ref dropdown, README),
 * the download review dialogs with their classification and structured note
 * copy, states, and unmount hygiene.
 *
 * Every injected spy is typed against `ManagePluginsTabInjected` rather than
 * cast: `tsconfig.test.json` type-checks this file, so a drift between the
 * spies and the face the page consumes fails the gate instead of the test.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { GitHubSearchPage, PluginInstallReview } from '../src/types.ts'
import { zh } from '../src/client/locales.ts'
import { MarketCallFailure } from '../src/client/channel.ts'
import { ManagePluginsTab, type ManagePluginsTabInjected, type ManagePluginsTabProps } from '../src/client/ManagePluginsTab.tsx'
import {
  makeInstallOutcome,
  makeInstallReview,
  makeList,
  makeRepositoryDetail,
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

/** Pick one option of a controlled select (fires the change React listens to). */
async function selectIn(select: Element | null | undefined, value: string): Promise<void> {
  if (select === null || select === undefined) throw new Error('select target missing')
  await act(async () => {
    ;(select as HTMLSelectElement).value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function submitForm(input: HTMLInputElement): void {
  act(() => { input.form?.requestSubmit() })
}

async function pressEnter(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

function pageOf(page: number, items: SearchItemSeed[], totalCount: number) {
  const pageData = makeSearchPage(items)
  return { totalCount, items: pageData.items }
}

/**
 * Switch to the GitHub tab and return the tab's own panel. Every GitHub-tab
 * assertion is scoped to this element: the page also carries the local
 * repository tab, which owns a filter input of its own.
 *
 * The MODAL dialogs are the one exception: InstallDialog and RemoveDialog are
 * rendered by the page (a sibling of both tabpanels), because a panel is only
 * `hidden` when the other tab is selected and a modal inside a hidden subtree
 * would be mounted-but-invisible. Look those up with `host.querySelector`,
 * never through `panelOf(host)`.
 */
async function openMarket(host: HTMLElement): Promise<HTMLElement> {
  await click(host.querySelector('[data-market-tab="github"]'))
  await flush()
  return panelOf(host)
}

/** The GitHub tab's own panel (all GitHub-tab assertions stay inside it). */
function panelOf(host: HTMLElement): HTMLElement {
  const panel = host.querySelector('[data-github-panel]')
  if (panel === null) throw new Error('the GitHub panel is not mounted')
  return panel as HTMLElement
}

async function searchIn(dialog: HTMLElement, keywords: string): Promise<void> {
  const input = dialog.querySelector<HTMLInputElement>('[data-market-search-input]')!
  await typeInto(input, keywords)
  submitForm(input)
  await flush()
}

describe('ManagePluginsTab GitHub tab', () => {
  it('keeps the local repository content on its own tab while the market is idle', async () => {
    const { props } = managePageHarness({ status: vi.fn(async () => makeStatus(false)) })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    // The landing tab is the local repository, whose idle state guides the
    // configuration; the GitHub tab is reachable from the strip and carries no
    // open-market button of its own.
    expect(host.querySelector('[data-open-market]')).toBeNull()
    expect(host.querySelector('[data-market-tab="github"]')).not.toBeNull()
    expect(host.querySelector('[data-market-status="idle"]')).not.toBeNull()
  })

  it('browses automatically on the first switch to the GitHub tab', async () => {
    const { props, mocks } = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const panel = await openMarket(host)
    // On mount with an empty box the tab browses all dsh plugins once (empty
    // keyword); the default mock returns no hits.
    expect(mocks.search).toHaveBeenCalledTimes(1)
    expect(mocks.search).toHaveBeenCalledWith('', 1)
    expect(panel.querySelector('[data-market-empty]')).not.toBeNull()
    expect(panel.querySelector('[data-detail-back]')).toBeNull()
  })

  it('searches inside the tab and renders result cards', async () => {
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
describe('ManagePluginsTab GitHub tab interactions', () => {
  it('offers a details entry on every row and never marks a downloaded one', async () => {
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
    expect(cards).toHaveLength(2)
    // Rows carry no download state at all: a repository whose record already
    // exists is offered exactly like an untouched one (the review reports the
    // existing record instead of the list pre-judging it).
    for (const card of Array.from(cards)) {
      expect(card.querySelector('[data-installed]')).toBeNull()
      expect(card.querySelector('[data-installed-badge]')).toBeNull()
      const details = card.querySelector('[data-row-details]') as HTMLButtonElement
      expect(details.disabled).toBe(false)
    }

    const managed = cards[0]!
    expect(managed.getAttribute('data-repository')).toBe('octocat/demo-plugin')
    expect(managed.querySelector('[data-row-details]')?.getAttribute('data-detail-repository'))
      .toBe('octocat/demo-plugin')
    // List rows never carry a direct download action: they open the detail
    // view, where the exact branch/tag is chosen.
    expect(managed.querySelector('[data-install-trigger]')).toBeNull()
  })

  it('downloads a branch from the detail view through the versioned preview flow', async () => {
    let snapshot = makeList([])
    const list = vi.fn(async () => snapshot)
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main', 'dev'],
      tags: ['v1.0.0'],
    }))
    const previewInstall = vi.fn(async (repository: string, version: string | null = null) =>
      makeInstallReview({ repository, ...(typeof version === 'string' ? { version } : {}) }))
    const install = vi.fn(async (repository: string, _token: string, version: string | null = null) => {
      snapshot = makeList([{
        key: `gh-${repository.replace('/', '-')}`,
        repository,
        ...(typeof version === 'string' ? { version } : {}),
        refKind: 'branch',
        enabled: false,
      }])
      return makeInstallOutcome({ repository, ...(typeof version === 'string' ? { version } : {}) })
    })
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ list, search, repositoryDetail, previewInstall, install })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')

    await click(dialog.querySelector('[data-row-details]'))
    await flush()
    expect(repositoryDetail).toHaveBeenCalledWith('acme/helper')

    // One merged dropdown encodes every ref with its kind; nothing is chosen
    // on entry, so the single download action below stays disabled.
    const select = dialog.querySelector('[data-ref-select]')
    const installAction = dialog.querySelector('[data-ref-install]') as HTMLButtonElement
    expect(select).not.toBeNull()
    expect(select?.querySelector('option[data-ref-name="dev"]')?.getAttribute('value')).toBe('branch:dev')
    expect(installAction.disabled).toBe(true)
    expect(installAction.textContent).toContain(zh.downloadButton)
    // The dropdown knows nothing about previous downloads.
    expect(select?.querySelector('[data-ref-installed]')).toBeNull()

    await selectIn(select, 'branch:dev')
    await flush()
    expect(installAction.disabled).toBe(false)
    // The action is a download: the ref is cloned into the local repository,
    // never loaded from GitHub directly.
    expect(installAction.textContent).toContain(zh.downloadButton)
    await click(installAction)
    await flush()
    // The download dialog is rendered by the PAGE, not by the GitHub panel:
    // it must stay visible while that panel is hidden, so look it up on the
    // page host rather than inside the panel subtree.
    const installDialog = host.querySelector('[data-dialog="install"]')
    expect(installDialog).not.toBeNull()
    expect(previewInstall).toHaveBeenCalledWith('acme/helper', 'dev', 'branch')

    await click(installDialog?.querySelector('[data-install-confirm]'))
    await flush()
    expect(install).toHaveBeenCalledWith('acme/helper', 'token-acme/helper', 'dev', 'branch')
    await click(installDialog?.querySelector('[data-dialog-done]'))
    await flush()
    expect(host.querySelector('[data-dialog="install"]')).toBeNull()

    // The roster reloaded, yet the downloaded ref is NOT marked and the same
    // ref stays downloadable: pre-existing records never gate the download.
    expect(list).toHaveBeenCalledTimes(2)
    const devOption = select?.querySelector('option[data-ref-name="dev"]')
    expect(devOption?.getAttribute('data-ref-installed')).toBeNull()
    expect(installAction.disabled).toBe(false)
    await selectIn(select, 'branch:main')
    await flush()
    expect(installAction.disabled).toBe(false)
    expect(installAction.textContent).toContain(zh.downloadButton)
  })

  it('shows overwrite and degraded notices when the detail preview reports them', async () => {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: [],
    }))
    const previewInstall = vi.fn(async (repository: string, version: string | null = null) => makeInstallReview({
      repository,
      ...(typeof version === 'string' ? { version } : {}),
      exists: true,
      degraded: true,
      dependencies: [],
      peerDependencies: [],
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, repositoryDetail, previewInstall })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')

    await click(dialog.querySelector('[data-row-details]'))
    await flush()
    await selectIn(dialog.querySelector('[data-ref-select]'), 'branch:main')
    await flush()
    await click(dialog.querySelector('[data-ref-install]'))
    await flush()
    expect(previewInstall).toHaveBeenCalledWith('acme/helper', 'main', 'branch')
    const installDialog = host.querySelector('[data-dialog="install"]')
    expect(installDialog?.querySelector('[data-overwrite-notice]')).not.toBeNull()
    const degraded = installDialog?.querySelector('[data-degraded-notice]')
    expect(degraded?.getAttribute('data-degraded-code')).toBe('github/bad-response')
    expect(degraded?.textContent).toContain(zh.degradedNotice.replace('{code}', 'github/bad-response'))
  })

  it('keeps the install dialog open on an expired confirmation and offers re-preview', async () => {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: ['v1.0.0'],
    }))
    const previewInstall = vi.fn(async (repository: string, version: string | null = null) =>
      makeInstallReview({ repository, ...(typeof version === 'string' ? { version } : {}) }))
    const install = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'market/confirm-expired', message: 'expired', details: {} })
    })
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, repositoryDetail, previewInstall, install })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')

    await click(dialog.querySelector('[data-row-details]'))
    await flush()
    await selectIn(dialog.querySelector('[data-ref-select]'), 'tag:v1.0.0')
    await flush()
    await click(dialog.querySelector('[data-ref-install]'))
    await flush()
    expect(previewInstall).toHaveBeenCalledWith('acme/helper', 'v1.0.0', 'tag')
    await click(host.querySelector('[data-install-confirm]'))
    await flush()
    expect(install).toHaveBeenCalledWith('acme/helper', 'token-acme/helper', 'v1.0.0', 'tag')
    const error = host.querySelector('[data-install-error]')
    expect(error).not.toBeNull()
    expect(error?.getAttribute('data-error-code')).toBe('market/confirm-expired')
    expect(error?.textContent).toContain(zh.confirmExpired)
    expect(host.querySelector('[data-repreview]')).not.toBeNull()
  })

  it('ignores a late search result after the page unmounts', async () => {
    let settle: (page: GitHubSearchPage) => void = () => {}
    // Typed against the injected face instead of `as never`: the harness then
    // really checks this spy against the contract the page consumes.
    const search = vi.fn<ManagePluginsTabInjected['search']>(() => new Promise(resolve => { settle = resolve }))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'agents')

    const root = roots.pop()!
    await act(async () => { root.unmount() })
    await act(async () => {
      settle(makeSearchPage([{ repository: 'acme/helper', name: 'helper' }]))
    })
    await flush()
    expect(host.textContent).toBe('')
    host.remove()
  })

  it('keeps the newest keywords when an older request resolves late', async () => {
    let settleOld: (page: GitHubSearchPage) => void = () => {}
    const search = vi.fn<ManagePluginsTabInjected['search']>((keywords) => {
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
describe('ManagePluginsTab GitHub tab auto browse & scroll zones', () => {
  it('browses once when the GitHub tab first mounts with an empty box', async () => {
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

    // Leaving and re-entering the tab reuses the mounted panel: the search
    // state (and the one auto-browse) survives instead of repeating.
    await click(host.querySelector('[data-market-tab="local"]'))
    await flush()
    dialog = await openMarket(host)
    expect(search).toHaveBeenCalledTimes(1)
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

    const scrollZone = dialog.querySelector<HTMLElement>('[data-market-scroll]')
    expect(scrollZone).not.toBeNull()
    expect(scrollZone?.querySelector('[data-market-results]')).not.toBeNull()
    // The search form is a sibling of the scroll zone, never inside it: it
    // stays visible while the result list scrolls under it.
    expect(scrollZone?.querySelector('[data-market-search-input]')).toBeNull()
    const pagination = dialog.querySelector('[data-pagination]')
    expect(pagination).not.toBeNull()
    expect(scrollZone?.contains(pagination)).toBe(false)
    const form = dialog.querySelector('[data-github-search]')
    expect(form).not.toBeNull()
    expect(scrollZone?.contains(form)).toBe(false)
    // The scrolling row of the list view is the result list itself; the zone
    // only hosts it (flexible + clipping), so nothing double-scrolls.
    expect(scrollZone?.querySelector('[data-market-results]')).not.toBeNull()
    expect(scrollZone?.style.overflowY).toBe('')
  })

  it('lets the page, the panels and every inner scroll zone follow the host height', async () => {
    const seed = Array.from({ length: 10 }, (_, index) => ({
      repository: `acme/plugin-${String(index + 1)}`,
      name: `plugin-${String(index + 1)}`,
    }))
    const search = vi.fn(async (_keywords: string, page: number) => pageOf(page, seed, 25))
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: [],
    }))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    // The page root is the full-height flex column of the settings host: it
    // never grows past the space it is given.
    const page = host.querySelector<HTMLElement>('[data-market-page]')!
    expect(page.style.height).toBe('100%')
    expect(page.style.minHeight).toBe('0px')

    // No panel grows the page: each one owns the leftover height and may
    // shrink below its content (min-height 0).
    const panels = Array.from(host.querySelectorAll<HTMLElement>('[data-market-panel]'))
    expect(panels).toHaveLength(2)
    for (const panel of panels) {
      expect(panel.style.flexGrow).toBe('1')
      expect(panel.style.flexShrink).toBe('1')
      expect(panel.style.minHeight).toBe('0px')
    }

    // The local repository body is the tab's own scroll zone.
    const localBody = host.querySelector<HTMLElement>('[data-manage-tab]')!
    expect(localBody.style.flexGrow).toBe('1')
    expect(localBody.style.minHeight).toBe('0px')

    const dialog = await openMarket(host)
    await searchIn(dialog, 'agents')
    const githubPanel = dialog.closest<HTMLElement>('[data-market-panel]')!
    expect(githubPanel.style.flexGrow).toBe('1')
    expect(githubPanel.style.minHeight).toBe('0px')
    expect(dialog.style.flexGrow).toBe('1')
    expect(dialog.style.minHeight).toBe('0px')

    // The result zone is bounded by the panel's leftover height only: no
    // viewport-fraction cap that would clip the list in an embedded page.
    const scrollZone = dialog.querySelector<HTMLElement>('[data-market-scroll]')!
    expect(scrollZone.style.flexGrow).toBe('1')
    expect(scrollZone.style.minHeight).toBe('0px')
    expect(scrollZone.style.maxHeight).toBe('')
    expect(scrollZone.style.height).toBe('')

    // Same contract for the detail view inside that zone.
    await click(dialog.querySelector('[data-row-details]'))
    await flush()
    const detailScroll = dialog.querySelector<HTMLElement>('[data-detail-scroll]')!
    expect(detailScroll.style.flexGrow).toBe('1')
    expect(detailScroll.style.minHeight).toBe('0px')
    const detailView = dialog.querySelector<HTMLElement>('[data-detail-view]')!
    expect(detailView.style.flexGrow).toBe('1')
    expect(detailView.style.minHeight).toBe('0px')

    // The scroll zones stay the only scrolling containers: the fixed header
    // (search form / detail toolbar) and the pagination footer never scroll.
    const detailHeader = dialog.querySelector<HTMLElement>('[data-github-detail-header]')!
    expect(detailHeader.style.maxHeight).toBe('')
    expect(detailHeader.style.flexGrow).toBe('')
  })

  it('keeps the detail head fixed and scrolls only the README row', async () => {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: ['v1.0.0'],
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')
    await click(dialog.querySelector('[data-row-details]'))
    await flush()

    const readme = dialog.querySelector<HTMLElement>('[data-readme-section]')!
    expect(readme).not.toBeNull()
    // The README row is the detail view's one scrolling row: it is the flexible
    // row (flex:1 + min-height:0) and carries the overflow.
    expect(readme.style.flexGrow).toBe('1')
    expect(readme.style.minHeight).toBe('0px')
    // …but flexible sizing only works inside a flex context: the pane wrapper
    // and the detail body must each be flex columns (jsdom cannot lay this out,
    // so the class contract is what pins it for the browser).
    const pane = dialog.querySelector<HTMLElement>('[data-detail-pane]')!
    expect(pane.className).not.toBe('')
    const body = dialog.querySelector<HTMLElement>('[data-detail-view]')!
    expect(pane.contains(body)).toBe(true)
    expect(body.contains(readme)).toBe(true)

    // Everything above it is pinned: the detail toolbar, the ref picker with
    // its download action, and the repository metadata all live OUTSIDE the
    // scrolling row, so a long document never scrolls them out of view.
    for (const selector of [
      '[data-github-detail-header]',
      '[data-ref-picker]',
      '[data-ref-install]',
      '[data-detail-header]',
    ]) {
      const pinned = dialog.querySelector<HTMLElement>(selector)
      expect(pinned).not.toBeNull()
      expect(readme.contains(pinned)).toBe(false)
    }

    // Neither the page nor the view wrappers scroll: no outer scrollbar beside
    // the README's own (their only sizing contract is flexible + shrinkable).
    const page = host.querySelector<HTMLElement>('[data-market-page]')!
    expect(page.style.overflowY).toBe('')
    const githubPanel = dialog.closest<HTMLElement>('[data-market-panel]')!
    expect(githubPanel.style.overflowY).toBe('')
    const zone = dialog.querySelector<HTMLElement>('[data-market-scroll]')!
    expect(zone.style.overflowY).toBe('')
    const detailScroll = dialog.querySelector<HTMLElement>('[data-detail-scroll]')!
    expect(detailScroll.style.overflowY).toBe('')
    const detailView = dialog.querySelector<HTMLElement>('[data-detail-view]')!
    expect(detailView.style.overflowY).toBe('')
  })

  it('keeps the local roster inside the same height-adaptive tab body', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-a', repository: 'acme/a', enabled: true },
      { key: 'gh-b', repository: 'acme/b', enabled: false },
      { key: 'gh-c', repository: 'acme/c', classification: 'skills' },
      { key: 'gh-d', repository: 'acme/d', classification: 'other' },
    ]))
    const { props } = managePageHarness({ list })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    // The landing tab is the local repository: its body owns the leftover
    // height and the roster grows inside it instead of scrolling the page.
    const panel = host.querySelector<HTMLElement>('[data-market-panel="local"]')!
    const body = panel.querySelector<HTMLElement>('[data-manage-tab]')!
    expect(body.style.flexGrow).toBe('1')
    expect(body.style.minHeight).toBe('0px')
    expect(body.style.maxHeight).toBe('')

    const roster = panel.querySelector<HTMLElement>('[data-managed-section]')
    expect(roster).not.toBeNull()
    expect(panel.querySelectorAll('[data-plugin-row]')).toHaveLength(4)
    // Rows are ordinary flow content of that body: no per-row viewport cap.
    for (const row of Array.from(panel.querySelectorAll<HTMLElement>('[data-plugin-row]'))) {
      expect(row.style.maxHeight).toBe('')
      expect(row.style.height).toBe('')
    }
  })
})

describe('ManagePluginsTab GitHub tab page jump', () => {
  const seeded = (page: number): SearchItemSeed[] => Array.from({ length: 10 }, (_, i) => ({
    repository: `acme/plugin-${String((page - 1) * 10 + i + 1)}`,
    name: `plugin-${String((page - 1) * 10 + i + 1)}`,
  }))

  it('jumps to a typed page on Enter and keeps the current keywords', async () => {
    const search = vi.fn(async (_keywords: string, page: number) => pageOf(page, seeded(page), 25))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'agents')

    const input = dialog.querySelector<HTMLInputElement>('[data-page-input]')
    expect(input).not.toBeNull()
    await typeInto(input!, '3')
    await pressEnter(input!)
    await flush()

    expect(search).toHaveBeenLastCalledWith('agents', 3)
    expect(dialog.querySelector('[data-page-count]')?.textContent)
      .toContain(zh.pagination.replace('{current}', '3').replace('{total}', '3').replace('{count}', '25'))
  })

  it('clamps out-of-range jumps and ignores invalid input', async () => {
    const search = vi.fn(async (_keywords: string, page: number) => pageOf(page, seeded(page), 25))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'agents')

    const input = dialog.querySelector<HTMLInputElement>('[data-page-input]')!
    await typeInto(input, '99')
    await pressEnter(input)
    await flush()
    expect(search).toHaveBeenLastCalledWith('agents', 3)
    const expectedLast = zh.pagination.replace('{current}', '3').replace('{total}', '3').replace('{count}', '25')
    expect(dialog.querySelector('[data-page-count]')?.textContent).toContain(expectedLast)

    // Re-resolve the input: the jump re-renders the footer subtree.
    const inputAfterJump = dialog.querySelector<HTMLInputElement>('[data-page-input]')!
    await typeInto(inputAfterJump, '0')
    await pressEnter(inputAfterJump)
    await flush()
    expect(search).toHaveBeenLastCalledWith('agents', 1)
    const expectedFirst = zh.pagination.replace('{current}', '1').replace('{total}', '3').replace('{count}', '25')
    expect(dialog.querySelector('[data-page-count]')?.textContent).toContain(expectedFirst)

    const callsBefore = search.mock.calls.length
    const inputAgain = dialog.querySelector<HTMLInputElement>('[data-page-input]')!
    await typeInto(inputAgain, 'abc')
    await pressEnter(inputAgain)
    await flush()
    expect(search.mock.calls.length).toBe(callsBefore)
  })

  it('jumps via the go button and omits the control for a single page', async () => {
    const search = vi.fn(async (_keywords: string, page: number) => pageOf(page, seeded(page), 25))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'agents')

    const input = dialog.querySelector<HTMLInputElement>('[data-page-input]')!
    await typeInto(input, '2')
    await click(dialog.querySelector('[data-page-go]'))
    await flush()
    expect(search).toHaveBeenLastCalledWith('agents', 2)

    const single = vi.fn(async () => pageOf(1, seeded(1).slice(0, 10), 10))
    const singleProps = managePageHarness({ search: single })
    const host2 = await renderInto(<ManagePluginsTab {...singleProps.props} />)
    await flush()
    const dialog2 = await openMarket(host2)
    await searchIn(dialog2, 'agents')
    expect(dialog2.querySelector('[data-page-input]')).toBeNull()
  })
})

describe('ManagePluginsTab GitHub repository detail view', () => {
  it('opens the detail view from a row and renders metadata, the merged ref dropdown and the README', async () => {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      name: 'helper',
      description: 'A helper plugin',
      stars: 42,
      updatedAt: '2026-03-02T00:00:00.000Z',
      branches: ['main', 'dev'],
      tags: ['v1.0.0', 'v2.0.0'],
      readme: '# Helper docs\n\n**bold** intro with `code`.\n',
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')
    await click(dialog.querySelector('[data-row-details]'))
    await flush()

    expect(repositoryDetail).toHaveBeenCalledTimes(1)
    expect(repositoryDetail).toHaveBeenCalledWith('acme/helper')
    // The detail view covers the list zone: search header and pagination hide.
    expect(dialog.querySelector('[data-market-search-input]')).toBeNull()
    expect(dialog.querySelector('[data-pagination]')).toBeNull()
    expect(dialog.querySelector('[data-detail-back]')?.textContent).toContain(zh.detailBack)
    const view = dialog.querySelector('[data-detail-view]')
    expect(view?.getAttribute('data-repository')).toBe('acme/helper')
    expect(view?.querySelector('[data-detail-name]')?.textContent).toContain('helper')
    expect(view?.querySelector('[data-detail-description]')?.textContent).toContain('A helper plugin')
    expect(view?.textContent).toContain(zh.starsLabel.replace('{count}', '42'))
    expect(view?.textContent).toContain(zh.updatedLabel.replace('{date}', '2026-03-02'))
    expect(view?.querySelector('[data-detail-link]')?.getAttribute('href')).toContain('github.com')

    // One merged dropdown below the metadata: a labelled select whose options
    // are grouped branches→tags, values encode the ref kind, the default
    // branch is pinned first with its mark, and an empty "select…" item leads.
    const select = view?.querySelector('[data-ref-select]') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    expect(select?.getAttribute('aria-label')).toBe(zh.refSelectLabel)
    expect(view?.querySelector('[data-ref-picker-label]')?.textContent).toContain(zh.refSelectLabel)
    const options = select ? Array.from(select.options) : []
    expect(options[0]?.value).toBe('')
    expect(options[0]?.textContent).toContain(zh.refSelectPlaceholder)

    const groups = Array.from(select?.querySelectorAll('[data-ref-optgroup]') ?? [])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.getAttribute('data-ref-kind')).toBe('branch')
    expect(groups[0]?.getAttribute('label')).toBe(zh.branchesTitle)
    expect(groups[1]?.getAttribute('data-ref-kind')).toBe('tag')
    expect(groups[1]?.getAttribute('label')).toBe(zh.tagsTitle)

    const branchOptions = Array.from(groups[0]?.querySelectorAll('[data-ref-option]') ?? [])
    expect(branchOptions).toHaveLength(2)
    expect(branchOptions[0]?.getAttribute('data-ref-name')).toBe('main')
    expect(branchOptions[0]?.getAttribute('value')).toBe('branch:main')
    expect(branchOptions[0]?.getAttribute('data-default-branch')).toBe('true')
    expect(branchOptions[0]?.textContent).toContain(zh.defaultBranchLabel)
    expect(branchOptions[1]?.getAttribute('data-ref-name')).toBe('dev')
    expect(branchOptions[1]?.getAttribute('value')).toBe('branch:dev')
    expect(branchOptions[1]?.getAttribute('data-default-branch')).toBeNull()

    const tagOptions = Array.from(groups[1]?.querySelectorAll('[data-ref-option]') ?? [])
    expect(tagOptions).toHaveLength(2)
    expect(tagOptions[0]?.getAttribute('value')).toBe('tag:v1.0.0')
    expect(tagOptions[1]?.getAttribute('value')).toBe('tag:v2.0.0')
    expect((view?.querySelector('[data-ref-install]') as HTMLButtonElement).disabled).toBe(true)

    const readme = view?.querySelector('[data-readme]')
    expect(readme).not.toBeNull()
    expect(readme?.innerHTML).toContain('<h1')
    expect(readme?.innerHTML).toContain('<strong>bold</strong>')
    expect(readme?.innerHTML).toContain('<code>code</code>')
  })

  it('returns from the detail view keeping the current keywords and page', async () => {
    const seed = (n: number): SearchItemSeed[] => Array.from({ length: 10 }, (_, i) => ({
      repository: `acme/p${String((n - 1) * 10 + i + 1)}`,
      name: `p${String((n - 1) * 10 + i + 1)}`,
    }))
    const search = vi.fn(async (_keywords: string, page: number) => pageOf(page, seed(page), 25))
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: [],
    }))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'agents')
    await click(dialog.querySelector('[data-page-next]'))
    await flush()
    expect(dialog.querySelector('[data-page-count]')?.textContent).toContain(zh.pagination
      .replace('{current}', '2').replace('{total}', '3').replace('{count}', '25'))

    await click(dialog.querySelector('[data-market-card] [data-row-details]'))
    await flush()
    expect(dialog.querySelector('[data-detail-view]')).not.toBeNull()
    const callsBefore = search.mock.calls.length
    await click(dialog.querySelector('[data-detail-back]'))
    await flush()
    // Back never re-runs the search: keywords and page are preserved as-is.
    expect(search.mock.calls.length).toBe(callsBefore)
    expect(dialog.querySelector('[data-market-results]')).not.toBeNull()
    expect(dialog.querySelector('[data-page-count]')?.textContent).toContain(zh.pagination
      .replace('{current}', '2').replace('{total}', '3').replace('{count}', '25'))
    const firstCard = dialog.querySelector('[data-market-card]')
    expect(firstCard?.getAttribute('data-repository')).toBe('acme/p11')
  })

  it('offers every ref of an already-downloaded repository, with no installed marker', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-acme-helper', repository: 'acme/helper', version: 'v1.0.0', enabled: false },
      { key: 'gh-acme-legacy', repository: 'acme/legacy', version: null, enabled: false },
      { key: 'gh-acme-both', repository: 'acme/both', version: 'v1', refKind: 'tag', enabled: false },
    ]))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
      { repository: 'acme/legacy', name: 'legacy' },
      { repository: 'acme/both', name: 'both' },
    ]))
    const repositoryDetail = vi.fn(async (repository: string) => {
      if (repository === 'acme/both') {
        return makeRepositoryDetail({ repository, branches: ['main', 'v1'], tags: ['v1'] })
      }
      if (repository === 'acme/legacy') {
        return makeRepositoryDetail({ repository, branches: ['main'], tags: ['v0.9.0'] })
      }
      return makeRepositoryDetail({ repository, branches: ['main'], tags: ['v1.0.0', 'v2.0.0'] })
    })
    const { props } = managePageHarness({ list, search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'plugins')

    // A managed record (git tag, legacy default-branch or a kinded ref) never
    // reaches the dropdown: no option is marked, no option is disabled.
    await click(dialog.querySelector(
      '[data-market-card][data-repository="acme/helper"] [data-row-details]',
    ))
    await flush()
    let select = dialog.querySelector('[data-ref-select]')
    let installAction = dialog.querySelector('[data-ref-install]') as HTMLButtonElement
    expect(select?.querySelectorAll('[data-ref-installed]')).toHaveLength(0)
    expect(select?.querySelector('option[data-ref-name="v1.0.0"]')?.getAttribute('data-ref-installed')).toBeNull()
    expect(select?.querySelector('option[data-ref-name="v1.0.0"]')?.textContent).toBe('v1.0.0')

    // The ref that was downloaded before is downloadable again: selecting it
    // enables the action, which keeps its plain download label.
    await selectIn(select, 'tag:v1.0.0')
    await flush()
    expect(installAction.disabled).toBe(false)
    expect(installAction.textContent).toContain(zh.downloadButton)
    await selectIn(select, 'tag:v2.0.0')
    await flush()
    expect(installAction.disabled).toBe(false)

    // Same-name branch and tag of a kinded record: neither is pre-marked.
    await click(dialog.querySelector('[data-detail-back]'))
    await flush()
    await click(dialog.querySelector(
      '[data-market-card][data-repository="acme/both"] [data-row-details]',
    ))
    await flush()
    select = dialog.querySelector('[data-ref-select]')
    expect(select?.querySelector('option[data-ref-name="v1"][data-ref-kind="tag"]')
      ?.getAttribute('data-ref-installed')).toBeNull()
    expect(select?.querySelector('option[data-ref-name="v1"][data-ref-kind="branch"]')
      ?.getAttribute('data-ref-installed')).toBeNull()
    installAction = dialog.querySelector('[data-ref-install]') as HTMLButtonElement
    await selectIn(select, 'tag:v1')
    await flush()
    expect(installAction.disabled).toBe(false)
    expect(installAction.textContent).toContain(zh.downloadButton)

    // A legacy record (version null) behaves exactly the same.
    await click(dialog.querySelector('[data-detail-back]'))
    await flush()
    await click(dialog.querySelector(
      '[data-market-card][data-repository="acme/legacy"] [data-row-details]',
    ))
    await flush()
    expect(dialog.querySelectorAll('[data-ref-select] option[data-ref-installed]')).toHaveLength(0)
    await selectIn(dialog.querySelector('[data-ref-select]'), 'tag:v0.9.0')
    await flush()
    expect((dialog.querySelector('[data-ref-install]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('renders the README as sanitized HTML with resolved relative links and images', async () => {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: [],
      readme: [
        '# Title',
        '',
        '**Bold** and `inline` code.',
        '',
        '[guide](./docs/guide.md)',
        '',
        '![logo](logo.png)',
        '',
        '<script>window.x = 1</script>',
        '',
        '<img src="x.png" onerror="alert(1)">',
        '',
      ].join('\n'),
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')
    await click(dialog.querySelector('[data-row-details]'))
    await flush()

    const readme = dialog.querySelector('[data-readme]')
    expect(readme).not.toBeNull()
    const html = readme?.innerHTML ?? ''
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('<code>inline</code>')
    // DOMPurify: script elements and event-handler attributes never survive.
    expect(readme?.querySelector('script')).toBeNull()
    expect(readme?.querySelector('[onerror]')).toBeNull()
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    // Relative links resolve under the default-branch blob base and open in a
    // new tab; images resolve under the raw base.
    const guide = readme?.querySelector('a[href*="guide.md"]')
    expect(guide?.getAttribute('href')).toBe('https://github.com/acme/helper/blob/main/docs/guide.md')
    expect(guide?.getAttribute('target')).toBe('_blank')
    expect(guide?.getAttribute('rel')).toContain('noreferrer')
    const logo = readme?.querySelector('img')
    expect(logo?.getAttribute('src')).toBe('https://github.com/acme/helper/raw/main/logo.png')
  })

  it('shows the no-README placeholder when the repository has none', async () => {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: ['v1.0.0'],
      readme: null,
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')
    await click(dialog.querySelector('[data-row-details]'))
    await flush()

    expect(dialog.querySelector('[data-readme]')).toBeNull()
    expect(dialog.querySelector('[data-readme-empty]')?.textContent).toContain(zh.noReadme)
  })

  it('shows a localized empty placeholder when the repository has no refs', async () => {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: [],
      tags: [],
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')
    await click(dialog.querySelector('[data-row-details]'))
    await flush()

    expect(dialog.querySelector('[data-ref-picker]')).toBeNull()
    expect(dialog.querySelector('[data-ref-select]')).toBeNull()
    expect(dialog.querySelector('[data-detail-empty]')?.textContent).toContain(zh.detailEmpty)
    expect(dialog.querySelector('[data-readme]')).not.toBeNull()
  })

  it('localizes a detail load failure and recovers through retry', async () => {
    const repositoryDetail = vi.fn()
      .mockRejectedValueOnce(new MarketCallFailure({
        code: 'github/rate-limit',
        message: 'limited',
        details: {},
      }))
      .mockResolvedValueOnce(makeRepositoryDetail({ repository: 'acme/helper', branches: ['main'], tags: [] }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')
    await click(dialog.querySelector('[data-row-details]'))
    await flush()

    const error = dialog.querySelector('[data-detail-error]')
    expect(error).not.toBeNull()
    expect(error?.getAttribute('data-error-code')).toBe('github/rate-limit')
    expect(error?.textContent).toContain(zh.rateLimited)

    await click(dialog.querySelector('[data-detail-retry]'))
    await flush()
    expect(repositoryDetail).toHaveBeenCalledTimes(2)
    expect(dialog.querySelector('[data-detail-error]')).toBeNull()
    expect(dialog.querySelector('[data-detail-view]')).not.toBeNull()
  })

  it('pins the default branch first even when the branch list does not start with it', async () => {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['dev', 'main'],
      tags: [],
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')
    await click(dialog.querySelector('[data-row-details]'))
    await flush()

    // 'main' is the default branch although the branch list leads with 'dev':
    // the dropdown reorders it to the head of the branch group with its mark.
    const branches = dialog.querySelectorAll('[data-ref-select] option[data-ref-kind="branch"]')
    expect(branches).toHaveLength(2)
    expect(branches[0]?.getAttribute('data-ref-name')).toBe('main')
    expect(branches[0]?.getAttribute('data-default-branch')).toBe('true')
    expect(branches[1]?.getAttribute('data-ref-name')).toBe('dev')
    expect(branches[1]?.getAttribute('data-default-branch')).toBeNull()
  })

  it('renders no empty branch/tag optgroup heading when that family has no refs', async () => {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: [],
      tags: ['v1.0.0'],
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')
    await click(dialog.querySelector('[data-row-details]'))
    await flush()

    // A group with zero options never renders its heading: no stray "Branches"
    // label above an empty select group.
    const select = dialog.querySelector('[data-ref-select]')
    expect(select?.querySelector('[data-ref-optgroup][data-ref-kind="branch"]')).toBeNull()
    const tagGroup = select?.querySelector('[data-ref-optgroup][data-ref-kind="tag"]')
    expect(tagGroup).not.toBeNull()
    expect(tagGroup?.getAttribute('label')).toBe(zh.tagsTitle)
    expect(tagGroup?.querySelectorAll('[data-ref-option]')).toHaveLength(1)
  })
})

describe('ManagePluginsTab download classification', () => {
  /** Search one repository, open its detail view and start the ref install. */
  async function openInstallDialog(host: HTMLElement): Promise<HTMLElement> {
    const market = await openMarket(host)
    await searchIn(market, 'helper')
    await click(market.querySelector('[data-row-details]'))
    await flush()
    await selectIn(market.querySelector('[data-ref-select]'), 'branch:main')
    await flush()
    await click(market.querySelector('[data-ref-install]'))
    await flush()
    // Page-level dialog (the GitHub panel never contains it).
    const installDialog = host.querySelector('[data-dialog="install"]')
    if (installDialog === null) throw new Error('install dialog did not open')
    return installDialog as HTMLElement
  }

  /** One-repository harness whose review result is fully under test control.
   *  The download itself resolves, so every state below can be driven to its
   *  confirmation and past it: nothing about a classification blocks it. */
  function classificationHarness(preview: ManagePluginsTabInjected['previewInstall']): {
    props: ManagePluginsTabProps
    previewInstall: ManagePluginsTabInjected['previewInstall']
    install: ManagePluginsTabInjected['install']
  } {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: [],
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const install = vi.fn(async (repository: string, _token: string, version: string | null = null) =>
      makeInstallOutcome({ repository, ...(typeof version === 'string' ? { version } : {}) }))
    const previewInstall = vi.fn<ManagePluginsTabInjected['previewInstall']>(preview)
    const { props } = managePageHarness({ search, repositoryDetail, previewInstall, install })
    return { props, previewInstall, install }
  }

  it.each([
    ['plugin', zh.classificationPlugin],
    ['skills', zh.classificationSkills],
    ['other', zh.classificationOther],
  ] as const)('names the %s classification in the download confirmation', async (classification, expected) => {
    const previewInstall = vi.fn(async (repository: string, version: string | null = null) =>
      makeInstallReview({ repository, ...(typeof version === 'string' ? { version } : {}), classification }))
    const { props, previewInstall: preview, install } = classificationHarness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)
    expect(preview).toHaveBeenCalledWith('acme/helper', 'main', 'branch')

    // The classification is announced, never used as a gate: the confirm
    // button stays available for every tag.
    const notice = installDialog.querySelector('[data-download-classification]')
    expect(notice?.textContent).toBe(zh.classificationNotice.replace('{classification}', expected))
    expect(installDialog.querySelector('[data-analysis-blocked]')).toBeNull()
    const confirm = installDialog.querySelector('[data-install-confirm]') as HTMLButtonElement
    expect(confirm).not.toBeNull()
    expect(confirm.disabled).toBe(false)

    await click(confirm)
    await flush()
    expect(install).toHaveBeenCalledWith('acme/helper', 'token-acme/helper', 'main', 'branch')
    expect(installDialog.querySelector('[data-install-done]')).not.toBeNull()
  })

  it('keeps a non-plugin analysis note informational and still downloads', async () => {
    const reason = 'This checkout ships agent skill packs instead of a plugin entry.'
    const previewInstall = vi.fn(async (repository: string, version: string | null = null) =>
      makeInstallReview({
        repository,
        ...(typeof version === 'string' ? { version } : {}),
        analysis: { kind: 'skills', reason },
        note: { kind: 'classified', text: reason },
        // Debug-only diagnostics MUST never reach the dialog as copy.
        entryNote: reason,
      }))
    const { props, install } = classificationHarness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)

    // The copy is the tab's own dictionary line keyed by note.kind; the analyzer
    // rationale stays a secondary detail; the old refusal panel (which replaced
    // the whole confirmation flow) is gone.
    expect(installDialog.querySelector('[data-download-classification]')?.textContent)
      .toBe(zh.classificationNotice.replace('{classification}', zh.classificationSkills))
    expect(installDialog.querySelector('[data-classification-note]')?.textContent).toBe(zh.classificationNote)
    expect(installDialog.querySelector('[data-classification-detail]')?.textContent).toBe(reason)
    expect(installDialog.querySelector('[data-analysis-blocked]')).toBeNull()
    expect(installDialog.querySelector('[data-analysis-title]')).toBeNull()
    expect(installDialog.querySelector('[data-analysis-close]')).toBeNull()
    expect(installDialog.querySelector('[data-install-confirm]')).not.toBeNull()

    await click(installDialog.querySelector('[data-install-confirm]'))
    await flush()
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('flags a checkout that needs a build before it can load', async () => {
    const previewInstall = vi.fn(async (repository: string, version: string | null = null) =>
      makeInstallReview({
        repository,
        ...(typeof version === 'string' ? { version } : {}),
        classification: 'other',
        buildRequired: true,
      }))
    const { props } = classificationHarness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)

    expect(installDialog.querySelector('[data-build-required]')?.textContent).toContain(zh.buildRequiredNotice)
    expect(installDialog.querySelector('[data-install-confirm]')).not.toBeNull()
  })

  it('renders the localized config guidance for an analysis-unavailable note', async () => {
    // The Host ships a structured note (kind only, no prose): the tab must
    // render its own copy for it, reusing the model-configuration guidance the
    // preview failure path shows.
    const previewInstall = vi.fn(async (repository: string, version: string | null = null) =>
      makeInstallReview({
        repository,
        ...(typeof version === 'string' ? { version } : {}),
        classification: 'other',
        note: { kind: 'analysis-unavailable' },
      }))
    const { props, install } = classificationHarness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)

    expect(installDialog.querySelector('[data-classification-note]')?.textContent).toBe(zh.analysisConfigGuide)
    expect(installDialog.querySelector('[data-classification-detail]')).toBeNull()
    expect(installDialog.querySelector('[data-install-confirm]')).not.toBeNull()

    await click(installDialog.querySelector('[data-install-confirm]'))
    await flush()
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('renders the entry-missing line for a checkout without a runnable entry', async () => {
    const previewInstall = vi.fn(async (repository: string, version: string | null = null) =>
      makeInstallReview({
        repository,
        ...(typeof version === 'string' ? { version } : {}),
        classification: 'other',
        note: { kind: 'entry-missing', entry: 'dist/index.js' },
      }))
    const { props } = classificationHarness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)

    // The host ships kind + expected entry; the tab renders its own copy for the
    // kind and appends the expected-entry template for `note.entry`.
    const note = installDialog.querySelector('[data-classification-note]')?.textContent ?? ''
    expect(note).toContain(zh.entryMissingNote)
    expect(note).toContain(zh.expectedEntryNote.replace('{entry}', 'dist/index.js'))
    expect(installDialog.querySelector('[data-classification-detail]')).toBeNull()
  })

  it('renders no note line for a review the host did not annotate', async () => {
    const previewInstall = vi.fn(async (repository: string, version: string | null = null) =>
      makeInstallReview({
        repository,
        ...(typeof version === 'string' ? { version } : {}),
        // Debug-only diagnostics alone must not produce a copy line.
        entryNote: 'The resolved plugin entry "index.js" does not exist inside the checkout.',
      }))
    const { props } = classificationHarness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)

    expect(installDialog.querySelector('[data-classification-note]')).toBeNull()
    expect(installDialog.querySelector('[data-classification-detail]')).toBeNull()
    expect(installDialog.textContent).not.toContain('does not exist inside the checkout')
    expect(installDialog.querySelector('[data-install-confirm]')).not.toBeNull()
  })

  it('shows the loading copy while the review preview is pending', async () => {
    let settle: (review: PluginInstallReview) => void = () => {}
    const previewInstall = vi.fn<ManagePluginsTabInjected['previewInstall']>(
      () => new Promise(resolve => { settle = resolve }),
    )
    const { props } = classificationHarness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)

    const loading = installDialog.querySelector('[data-preview-loading]')
    expect(loading?.textContent).toContain(zh.previewing)
    expect(installDialog.querySelector('[data-install-confirm]')).toBeNull()

    await act(async () => { settle(makeInstallReview({ repository: 'acme/helper', version: 'main' })) })
    await flush()
    expect(installDialog.querySelector('[data-preview-loading]')).toBeNull()
    expect(installDialog.querySelector('[data-install-confirm]')).not.toBeNull()
    expect(installDialog.querySelector('[data-download-classification]')?.textContent)
      .toBe(zh.classificationNotice.replace('{classification}', zh.classificationPlugin))
  })

  it('guides to configure the analysis model when the preview rejects llm-unconfigured', async () => {
    const previewInstall = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'market/llm-unconfigured', message: 'no llm endpoint', details: {} })
    })
    const { props, install } = classificationHarness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)

    const error = installDialog.querySelector('[data-preview-error]')
    expect(error?.getAttribute('data-error-code')).toBe('market/llm-unconfigured')
    // The manifest-read prefix never labels an analysis failure.
    expect(error?.textContent).toContain(zh.analysisNotConfigured)
    expect(error?.textContent).not.toContain(zh.previewFailed)
    expect(installDialog.querySelector('[data-analysis-guide]')?.textContent).toContain(zh.analysisConfigGuide)
    // A missing config cannot be fixed by retrying here: close-only, no confirm.
    expect(installDialog.querySelector('[data-preview-retry]')).toBeNull()
    expect(installDialog.querySelector('[data-install-confirm]')).toBeNull()
    expect(install).not.toHaveBeenCalled()
    await click(installDialog.querySelector('[data-analysis-close]'))
    expect(host.querySelector('[data-dialog="install"]')).toBeNull()
  })

  it.each([
    ['market/llm-failed', zh.analysisModelFailed],
    ['market/llm-bad-output', zh.analysisBadOutput],
  ] as const)('shows the %s analysis failure with retry and close', async (code, expected) => {
    const previewInstall = vi.fn()
      .mockRejectedValueOnce(new MarketCallFailure({ code, message: 'model trouble', details: {} }))
      .mockResolvedValueOnce(makeInstallReview({ repository: 'acme/helper', version: 'main' }))
    const { props, previewInstall: preview, install } = classificationHarness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)

    const error = installDialog.querySelector('[data-preview-error]')
    expect(error?.getAttribute('data-error-code')).toBe(code)
    expect(error?.textContent).toContain(expected)
    expect(error?.textContent).not.toContain(zh.previewFailed)
    expect(installDialog.querySelector('[data-analysis-guide]')).toBeNull()
    expect(installDialog.querySelector('[data-install-confirm]')).toBeNull()

    // Retry re-runs the preview and recovers into the confirmation flow.
    const retry = installDialog.querySelector('[data-preview-retry]') as HTMLButtonElement
    expect(retry).not.toBeNull()
    expect(installDialog.querySelector('[data-analysis-close]')).not.toBeNull()
    expect(install).not.toHaveBeenCalled()
    await click(retry)
    await flush()
    expect(preview).toHaveBeenCalledTimes(2)
    expect(installDialog.querySelector('[data-preview-error]')).toBeNull()
    expect(installDialog.querySelector('[data-install-confirm]')).not.toBeNull()
    expect(install).not.toHaveBeenCalled()
  })
})

describe('ManagePluginsTab tab switches with an open dialog', () => {
  /** Open the download review from the GitHub tab's detail view. */
  async function openInstallDialog(host: HTMLElement): Promise<HTMLElement> {
    const market = await openMarket(host)
    await searchIn(market, 'helper')
    await click(market.querySelector('[data-row-details]'))
    await flush()
    await selectIn(market.querySelector('[data-ref-select]'), 'branch:main')
    await flush()
    await click(market.querySelector('[data-ref-install]'))
    await flush()
    const dialog = host.querySelector('[data-dialog="install"]')
    if (dialog === null) throw new Error('install dialog did not open')
    return dialog as HTMLElement
  }

  function oneRepoHarness() {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: [],
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    return { repositoryDetail, search }
  }

  it('keeps the open download dialog visible and focusable when the GitHub tab is hidden', async () => {
    const { repositoryDetail, search } = oneRepoHarness()
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openInstallDialog(host)
    expect(dialog.contains(document.activeElement)).toBe(true)

    await click(host.querySelector('[data-market-tab="local"]'))
    await flush()

    // The dialogs live at page level, so hiding the GitHub panel cannot hide
    // them: no mounted-but-invisible aria-modal, and the focus stays on a
    // visible control inside the dialog.
    const githubPanel = host.querySelector<HTMLElement>('[data-market-panel="github"]')!
    expect(githubPanel.hidden).toBe(true)
    expect(githubPanel.contains(dialog)).toBe(false)
    const stillOpen = host.querySelector('[data-dialog="install"]')
    expect(stillOpen).not.toBeNull()
    expect(stillOpen!.closest('[hidden]')).toBeNull()
    expect(stillOpen!.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.closest('[hidden]')).toBeNull()

    // The review is still fully operable from the local tab, and closing it
    // returns the user to the tab they are actually looking at.
    await click(stillOpen!.querySelector('[data-dialog-cancel]'))
    await flush()
    expect(host.querySelector('[data-dialog="install"]')).toBeNull()
    expect(host.querySelector('[data-market-tab="local"]')?.getAttribute('aria-selected')).toBe('true')
    // The hidden GitHub tab kept its own state through all of it.
    expect(panelOf(host).querySelector('[data-detail-view]')).not.toBeNull()
  })

  it('keeps the open removal dialog visible and focusable when the local tab is hidden', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false },
    ]))
    const { props } = managePageHarness({ list })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    await click(host.querySelector('[data-remove-trigger]'))
    await flush()
    const dialog = host.querySelector('[data-dialog="remove"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.contains(document.activeElement)).toBe(true)

    await click(host.querySelector('[data-market-tab="github"]'))
    await flush()

    const localPanel = host.querySelector<HTMLElement>('[data-market-panel="local"]')!
    expect(localPanel.hidden).toBe(true)
    expect(localPanel.contains(dialog)).toBe(false)
    const stillOpen = host.querySelector('[data-dialog="remove"]')
    expect(stillOpen).not.toBeNull()
    expect(stillOpen!.closest('[hidden]')).toBeNull()
    expect(stillOpen!.contains(document.activeElement)).toBe(true)

    // Escape still dismisses it from the GitHub tab, and the removal target is
    // cleared rather than left pending behind the hidden panel.
    await act(async () => {
      stillOpen!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await flush()
    expect(host.querySelector('[data-dialog="remove"]')).toBeNull()
    expect(host.querySelector('[data-plugin-row]')).not.toBeNull()
  })
})

describe('ManagePluginsTab dialog exits & keyboard affordances', () => {
  /** Open the market modal and drive it into the install review dialog. */
  async function openInstallDialog(host: HTMLElement): Promise<HTMLElement> {
    const market = await openMarket(host)
    await searchIn(market, 'helper')
    await click(market.querySelector('[data-row-details]'))
    await flush()
    await selectIn(market.querySelector('[data-ref-select]'), 'branch:main')
    await flush()
    await click(market.querySelector('[data-ref-install]'))
    await flush()
    // Page-level dialog (the GitHub panel never contains it).
    const installDialog = host.querySelector('[data-dialog="install"]')
    if (installDialog === null) throw new Error('install dialog did not open')
    return installDialog as HTMLElement
  }

  function oneRepoHarness() {
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: [],
    }))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    return { repositoryDetail, search }
  }

  /** Dispatch one keyboard event on a target (bubbles to the dialog shell). */
  async function pressKey(target: Element | null, key: string, shiftKey = false): Promise<void> {
    if (target === null) throw new Error('keyboard target missing')
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        shiftKey,
      }))
    })
  }

  it('offers a close exit on a non-analysis preview failure', async () => {
    const previewInstall = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'github/network', message: 'down', details: {} })
    })
    const { repositoryDetail, search } = oneRepoHarness()
    const { props } = managePageHarness({ search, repositoryDetail, previewInstall })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const installDialog = await openInstallDialog(host)
    const previewError = installDialog.querySelector('[data-preview-error]')
    expect(previewError?.getAttribute('data-error-code')).toBe('github/network')
    // A transport/manifest preview failure gets Retry plus a close exit.
    expect((installDialog.querySelector('[data-preview-retry]') as HTMLButtonElement)).not.toBeNull()
    const cancel = installDialog.querySelector('[data-dialog-cancel]') as HTMLButtonElement
    expect(cancel).not.toBeNull()
    await click(cancel)
    expect(host.querySelector('[data-dialog="install"]')).toBeNull()
    // The GitHub tab (and its detail view) stays exactly where it was.
    expect(panelOf(host).querySelector('[data-detail-view]')).not.toBeNull()
  })

  it('recovers any non-expired install failure through re-preview', async () => {
    const previewInstall = vi.fn(async (repository: string, version: string | null = null) =>
      makeInstallReview({ repository, ...(typeof version === 'string' ? { version } : {}) }))
    const install = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'install/git-failed', message: 'git failed', details: {} })
    })
    const { repositoryDetail, search } = oneRepoHarness()
    const { props } = managePageHarness({ search, repositoryDetail, previewInstall, install })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const installDialog = await openInstallDialog(host)
    expect(installDialog.querySelector('[data-preview-error]')).toBeNull()
    await click(installDialog.querySelector('[data-install-confirm]'))
    await flush()
    const installError = installDialog.querySelector('[data-install-error]')
    expect(installError?.getAttribute('data-error-code')).toBe('install/git-failed')
    const rePreview = installDialog.querySelector('[data-repreview]') as HTMLButtonElement
    expect(rePreview).not.toBeNull()
    expect(rePreview.textContent).toContain(zh.repreviewButton)
    expect(install).toHaveBeenCalledTimes(1)
    // Re-preview re-runs the review and returns to the confirmation flow.
    await click(rePreview)
    await flush()
    expect(previewInstall).toHaveBeenCalledTimes(2)
    expect(installDialog.querySelector('[data-install-error]')).toBeNull()
    expect(installDialog.querySelector('[data-install-confirm]')).not.toBeNull()
  })

  it('labels a missing repository with its own not-found copy', async () => {
    const previewInstall = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'github/not-found', message: 'gone', details: {} })
    })
    const { repositoryDetail, search } = oneRepoHarness()
    const { props } = managePageHarness({ search, repositoryDetail, previewInstall })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)

    const error = installDialog.querySelector('[data-preview-error]')
    expect(error?.getAttribute('data-error-code')).toBe('github/not-found')
    expect(error?.textContent).toContain(zh.githubNotFound)
    expect(error?.textContent).not.toContain(zh.githubAuthError)
  })

  it('returns to the list from the detail view on Escape', async () => {
    const { repositoryDetail, search } = oneRepoHarness()
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openMarket(host)
    await searchIn(dialog, 'helper')
    await click(dialog.querySelector('[data-row-details]'))
    await flush()
    expect(dialog.querySelector('[data-detail-view]')).not.toBeNull()
    const callsBefore = search.mock.calls.length

    // The panel is plain in-page content now (no modal shell): Escape is its
    // own shortcut back to the result list, leaving keywords and page alone.
    await pressKey(dialog.querySelector('[data-detail-back]'), 'Escape')
    await flush()
    expect(dialog.querySelector('[data-detail-view]')).toBeNull()
    expect(dialog.querySelector('[data-market-results]')).not.toBeNull()
    expect(search.mock.calls.length).toBe(callsBefore)

    // Escape outside the detail view is a no-op: the tab stays as it is.
    await pressKey(dialog.querySelector('[data-market-search-input]'), 'Escape')
    await flush()
    expect(dialog.querySelector('[data-market-results]')).not.toBeNull()
    expect(host.querySelector('[data-market-tab="github"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('closes the nested install dialog first on Escape and keeps the tab', async () => {
    const { repositoryDetail, search } = oneRepoHarness()
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const installDialog = await openInstallDialog(host)
    expect(installDialog.contains(document.activeElement)).toBe(true)

    // Escape inside the install dialog only dismisses it; the detail view and
    // the GitHub tab underneath stay as they were.
    await pressKey(installDialog.querySelector('[data-install-confirm]'), 'Escape')
    await flush()
    expect(host.querySelector('[data-dialog="install"]')).toBeNull()
    expect(panelOf(host).querySelector('[data-detail-view]')).not.toBeNull()
    expect(host.querySelector('[data-market-tab="github"]')?.getAttribute('aria-selected')).toBe('true')
  })
})
