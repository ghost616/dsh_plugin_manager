// @vitest-environment jsdom
/**
 * 离朱独立验证（round 7：访问令牌页 / 手动刷新 / 限流可选文案）
 *
 * 第二视角：不复用力牧的用例，而是从需求条目反向构造观测点。所有断言都走真实
 * DOM 交互（点击 / 键盘 / 输入），不直接读写组件内部状态。
 *
 * 覆盖维度：
 *  - 正向：三态渲染、保存/清除后的状态、刷新按当前 keywords/page 重发；
 *  - 反向：未知错误码回落 {code}、缺 retryAfterMs 不渲染等待行、详情重试仍走缓存读；
 *  - 边界：retryAfterMs = 0 / 负数 / NaN / 字符串 / Infinity、写操作在途与卸载竞态；
 *  - 跨状态：页内标签切换（未访问不挂载、切走再切回不重复读取）、刷新在途仍可切换标签。
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { GitHubSearchPage, GitHubTokenUpdateResult } from '../src/types.ts'
import { zh } from '../src/client/locales.ts'
import { MarketCallFailure, type MarketClientWireCode } from '../src/client/channel.ts'
import {
  ManagePluginsTab,
  SEARCH_PAGE_SIZE,
  rateLimitWaitLine,
  rateLimitWaitText,
  tokenSourceText,
  type ManageUiFailure,
} from '../src/client/ManagePluginsTab.tsx'
import {
  makeRepositoryDetail,
  makeSearchPage,
  makeStatus,
  makeTokenStatus,
  makeTokenUpdate,
  makeTranslator,
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

async function pressKey(target: Element | null | undefined, key: string): Promise<void> {
  if (target === null || target === undefined) throw new Error('keyboard target missing')
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A promise plus its resolver, for driving in-flight windows deterministically. */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

/** The {ref} / {source} / {state} line of one token state (zh templates). */
function statusLine(seed: { configured: boolean; source: string; ref: string }): string {
  return zh.tokenStatusLine
    .replace('{ref}', seed.ref)
    .replace('{source}', seed.source)
    .replace('{state}', seed.configured ? zh.tokenConfigured : zh.tokenUnconfigured)
}

/** Compact search-result seeds. */
function items(count: number): SearchItemSeed[] {
  return Array.from({ length: count }, (_, index) => ({ repository: 'octocat/repo-' + String(index + 1) }))
}

/** One normalized UI failure for the pure copy functions. */
function failure(code: string, details: Readonly<Record<string, unknown>> = {}): ManageUiFailure {
  return { code, message: 'wire message', details }
}

/** 一页 10 条、总数 12：翻页控件可用，但单页只渲染 SEARCH_PAGE_SIZE 条。 */
function pageOf(itemsInPage: number, totalCount: number) {
  return { totalCount, items: makeSearchPage(items(itemsInPage)).items }
}

/** Open the page and land on the given in-page tab. */
async function openTab(
  overrides: Parameters<typeof managePageHarness>[0],
  tab: 'local' | 'github' | 'token',
): Promise<HTMLElement> {
  const { props } = managePageHarness(overrides)
  const host = await renderInto(<ManagePluginsTab {...props} />)
  await flush()
  await click(host.querySelector('[data-market-tab="' + tab + '"]'))
  await flush()
  return host
}
describe('[离朱] 页内第三个标签：键盘可达性与惰性挂载', () => {
  it('End 落在 token 标签并把焦点移过去；token 面板在选中前不挂载、不读取', async () => {
    const harness = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...harness.props} />)
    await flush()

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-market-tab]'))
    expect(tabs.map(tab => tab.getAttribute('data-market-tab'))).toEqual(['local', 'github', 'token'])
    // 惰性挂载：未点开 token 之前没有面板，也没有任何状态读取。
    expect(host.querySelector('[data-market-token-panel]')).toBeNull()
    expect(harness.props.tokenStatus).not.toHaveBeenCalled()

    // Home 回到第一个标签，End 落在最后一个（token），焦点随之移动。
    // End 落在最后一个（token）标签并把焦点移过去：这正是 token 面板的首次挂载点。
    await pressKey(tabs[0], 'End')
    expect(document.activeElement).toBe(tabs[2])
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[2]!.tabIndex).toBe(0)
    // 面板在标签被选中的那一刻挂载，且只读一次状态。
    expect(harness.props.tokenStatus).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-market-token-panel]')).not.toBeNull()

    // Home 回到第一个标签：焦点与选中态一起回到 local。
    await pressKey(tabs[2]!, 'Home')
    expect(document.activeElement).toBe(tabs[0])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]!.tabIndex).toBe(0)
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('false')

    // 从 token 出发右移（环回 local）：切走只是隐藏，不产生第二次读取。
    await pressKey(tabs[2]!, 'ArrowRight')
    expect(document.activeElement).toBe(tabs[0])
    expect(tabs[0]!.tabIndex).toBe(0)
    expect(tabs[2]!.tabIndex).toBe(-1)
    expect(harness.props.tokenStatus).toHaveBeenCalledTimes(1)
    expect(host.querySelector<HTMLElement>('[data-market-panel="token"]')!.hidden).toBe(true)
  })

  it('切走再切回 token：面板保持挂载、未提交输入保留且不再二次读取', async () => {
    const tokenStatus = vi.fn(async () => makeTokenStatus({
      configured: true,
      source: 'file',
      writable: true,
    }))
    const host = await openTab({ tokenStatus }, 'token')
    expect(tokenStatus).toHaveBeenCalledTimes(1)
    await typeInto(host.querySelector<HTMLInputElement>('[data-token-input]')!, 'half-typed')

    await click(host.querySelector('[data-market-tab="local"]'))
    await flush()
    // 隐藏而非卸载：面板仍在文档里，但被显式摘出布局。
    expect(host.querySelector('[data-market-token-panel]')).not.toBeNull()
    expect(host.querySelector<HTMLElement>('[data-market-panel="token"]')!.style.display).toBe('none')
    expect(host.querySelector<HTMLElement>('[data-market-panel="token"]')!.hidden).toBe(true)
    expect(host.querySelectorAll<HTMLElement>('[data-market-panel]:not([style*="display: none"])')).toHaveLength(1)

    await click(host.querySelector('[data-market-tab="token"]'))
    await flush()
    expect(tokenStatus).toHaveBeenCalledTimes(1)
    expect(host.querySelector<HTMLInputElement>('[data-token-input]')!.value).toBe('half-typed')
  })
})

describe('[离朱] 令牌面板三态（一律以 tokenStatus 的返回为准）', () => {
  it('未配置但可写：状态行仍显示实际生效引用名 GITHUB_TOKEN，保存可用、清除禁用', async () => {
    const host = await openTab({
      tokenStatus: vi.fn(async () => makeTokenStatus({
        configured: false,
        writable: true,
        ref: 'GITHUB_TOKEN',
      })),
    }, 'token')
    const panel = host.querySelector<HTMLElement>('[data-market-token-panel]')!

    const status = panel.querySelector<HTMLElement>('[data-token-status]')!
    expect(status.getAttribute('data-token-configured')).toBe('false')
    // 只有 GITHUB_TOKEN 生效的部署不得显示成「另一个引用未配置」。
    expect(status.textContent).toContain('GITHUB_TOKEN')
    expect(status.textContent).toBe(statusLine({
      configured: false,
      source: zh.tokenSourceOther,
      ref: 'GITHUB_TOKEN',
    }))

    const hint = panel.querySelector<HTMLElement>('[data-token-hint]')!
    expect(hint.textContent).toBe(zh.tokenSourceHint.replace('{ref}', 'GITHUB_TOKEN'))
    expect(hint.getAttribute('data-token-readonly')).toBeNull()

    expect(panel.querySelector<HTMLInputElement>('[data-token-input]')!.disabled).toBe(false)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-save]')!.disabled).toBe(false)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-clear]')!.disabled).toBe(true)
  })

  it('存储文件提供：输入 / 保存 / 清除三者均可用，状态行含「已配置」与来源标签', async () => {
    const host = await openTab({
      tokenStatus: vi.fn(async () => makeTokenStatus({
        configured: true,
        source: 'file',
        writable: true,
      })),
    }, 'token')
    const panel = host.querySelector<HTMLElement>('[data-market-token-panel]')!

    expect(panel.querySelector<HTMLInputElement>('[data-token-input]')!.disabled).toBe(false)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-save]')!.disabled).toBe(false)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-clear]')!.disabled).toBe(false)
    const status = panel.querySelector<HTMLElement>('[data-token-status]')!
    expect(status.textContent).toContain(zh.tokenConfigured)
    expect(status.textContent).toContain(zh.tokenSourceFile)
    expect(status.getAttribute('data-token-configured')).toBe('true')
    expect(panel.querySelector<HTMLElement>('[data-token-hint]')!.getAttribute('data-token-readonly')).toBeNull()
  })

  it('启动环境提供：三个动作全部 disabled、点击不发请求、只读提示指向启动 shell', async () => {
    const saveToken = vi.fn(async () => makeTokenUpdate({ configured: true, source: 'file' }))
    const clearToken = vi.fn(async () => makeTokenUpdate({ configured: false }))
    const host = await openTab({
      tokenStatus: vi.fn(async () => makeTokenStatus({
        configured: true,
        source: 'env',
        writable: false,
        ref: 'DSH_GITHUB_TOKEN',
      })),
      saveToken,
      clearToken,
    }, 'token')
    const panel = host.querySelector<HTMLElement>('[data-market-token-panel]')!

    expect(panel.querySelector<HTMLInputElement>('[data-token-input]')!.disabled).toBe(true)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-save]')!.disabled).toBe(true)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-clear]')!.disabled).toBe(true)
    const hint = panel.querySelector<HTMLElement>('[data-token-hint]')!
    expect(hint.getAttribute('data-token-readonly')).toBe('true')
    expect(hint.textContent).toBe(zh.tokenEnvHint.replace('{ref}', 'DSH_GITHUB_TOKEN'))

    await click(panel.querySelector('[data-token-save]'))
    await click(panel.querySelector('[data-token-clear]'))
    await flush()
    expect(saveToken).not.toHaveBeenCalled()
    expect(clearToken).not.toHaveBeenCalled()
  })
})
describe('[离朱] 令牌写入的错误分支与在途状态', () => {
  it('未知错误码回落 {code} 文案，失败后不清空输入、不改动既有状态', async () => {
    const saveToken = vi.fn(async (_value: string | null) => {
      throw new MarketCallFailure({ code: 'github/teapot' as MarketClientWireCode, message: 'weird', details: {} })
    })
    const host = await openTab({
      tokenStatus: vi.fn(async () => makeTokenStatus({ configured: false, writable: true, ref: 'GITHUB_TOKEN' })),
      saveToken,
    }, 'token')
    const panel = host.querySelector<HTMLElement>('[data-market-token-panel]')!
    const input = panel.querySelector<HTMLInputElement>('[data-token-input]')!

    await typeInto(input, 'ghp_typed_value')
    await click(panel.querySelector('[data-token-save]'))
    await flush()

    expect(saveToken).toHaveBeenCalledWith('ghp_typed_value')
    const error = panel.querySelector<HTMLElement>('[data-token-error]')!
    expect(error.getAttribute('data-error-code')).toBe('github/teapot')
    expect(error.textContent).toBe(zh.tokenErrorWithCode.replace('{code}', 'github/teapot'))
    // 失败路径不动本地状态：输入保留（用户可改可重试），状态行与配置标记不变。
    expect(input.value).toBe('ghp_typed_value')
    expect(panel.querySelector('[data-token-notice]')).toBeNull()
    const status = panel.querySelector<HTMLElement>('[data-token-status]')!
    expect(status.getAttribute('data-token-configured')).toBe('false')
    expect(status.textContent).toContain('GITHUB_TOKEN')
    expect(panel.querySelector<HTMLButtonElement>('[data-token-save]')!.disabled).toBe(false)
  })

  it('写操作在途：body aria-busy、输入与双动作禁用、保存按钮显示在途文案；答复后恢复', async () => {
    const pending = deferred<GitHubTokenUpdateResult>()
    const host = await openTab({
      tokenStatus: vi.fn(async () => makeTokenStatus({ configured: false, writable: true })),
      saveToken: vi.fn(() => pending.promise),
    }, 'token')
    const panel = host.querySelector<HTMLElement>('[data-market-token-panel]')!
    const input = panel.querySelector<HTMLInputElement>('[data-token-input]')!

    await typeInto(input, 'ghp_pending')
    await click(panel.querySelector('[data-token-save]'))

    const body = panel.querySelector<HTMLElement>('[data-token-body]')!
    expect(body.getAttribute('aria-busy')).toBe('true')
    expect(input.disabled).toBe(true)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-save]')!.disabled).toBe(true)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-clear]')!.disabled).toBe(true)
    expect(panel.querySelector('[data-token-save]')?.textContent).toContain(zh.tokenSaving)

    await act(async () => { pending.settle(makeTokenUpdate({ configured: true, source: 'file' })) })
    await flush()
    expect(body.getAttribute('aria-busy')).toBe('false')
    expect(input.disabled).toBe(false)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-save]')!.disabled).toBe(false)
    expect(panel.querySelector('[data-token-save]')?.textContent).toContain(zh.tokenSaveButton)
    expect(panel.querySelector('[data-token-notice]')?.textContent).toBe(zh.tokenSaved)
    expect(input.value).toBe('')
  })

  it('清除在途同样置忙；晚到的答复把状态改回未配置并禁用清除', async () => {
    const pending = deferred<GitHubTokenUpdateResult>()
    const host = await openTab({
      tokenStatus: vi.fn(async () => makeTokenStatus({ configured: true, source: 'file', writable: true })),
      clearToken: vi.fn(() => pending.promise),
    }, 'token')
    const panel = host.querySelector<HTMLElement>('[data-market-token-panel]')!

    await click(panel.querySelector('[data-token-clear]'))
    expect(panel.querySelector<HTMLElement>('[data-token-body]')!.getAttribute('aria-busy')).toBe('true')

    await act(async () => { pending.settle(makeTokenUpdate({ configured: false, ref: 'GITHUB_TOKEN' })) })
    await flush()
    const status = panel.querySelector<HTMLElement>('[data-token-status]')!
    expect(status.getAttribute('data-token-configured')).toBe('false')
    expect(status.textContent).toBe(statusLine({
      configured: false,
      source: zh.tokenSourceOther,
      ref: 'GITHUB_TOKEN',
    }))
    expect(panel.querySelector<HTMLButtonElement>('[data-token-clear]')!.disabled).toBe(true)
    expect(panel.querySelector('[data-token-notice]')?.textContent).toBe(zh.tokenCleared)
  })
})
describe('[离朱] 手动刷新绕过 TTL 缓存', () => {
  it('列表刷新按当前 keywords/page 重发并带 refresh=true，在途禁用按钮；自动浏览与翻页均为 undefined', async () => {
    const queue: { promise: Promise<GitHubSearchPage>; settle: (value: GitHubSearchPage) => void }[] = []
    const search = vi.fn((_keywords: string, _page: number, _refresh?: boolean) => {
      const entry = deferred<GitHubSearchPage>()
      queue.push(entry)
      return entry.promise
    })
    const host = await openTab({ search }, 'github')

    // 首次空关键词自动浏览：第三个实参为 undefined（wire 上不出现 refresh 键）。
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0]!.slice(0, 3)).toEqual(['', 1, undefined])
    await act(async () => { queue[0]!.settle(pageOf(SEARCH_PAGE_SIZE, 12)) })
    await flush()

    // 翻页：仍是缓存读。
    await click(host.querySelector('[data-page-next]'))
    expect(search).toHaveBeenCalledTimes(2)
    expect(search.mock.calls[1]!.slice(0, 3)).toEqual(['', 2, undefined])
    await act(async () => { queue[1]!.settle(pageOf(SEARCH_PAGE_SIZE, 12)) })
    await flush()

    // 刷新：以当前 keywords/page 重发，并显式 refresh=true。
    await click(host.querySelector('[data-market-refresh]'))
    expect(search).toHaveBeenCalledTimes(3)
    expect(search.mock.calls[2]!.slice(0, 3)).toEqual(['', 2, true])
    const refreshButton = host.querySelector<HTMLButtonElement>('[data-market-refresh]')!
    expect(refreshButton.disabled).toBe(true)
    expect(host.querySelector('[data-market-loading]')).not.toBeNull()

    // 刷新在途不阻塞页内标签切换，也不阻塞本地面板。
    await click(host.querySelector('[data-market-tab="local"]'))
    await flush()
    expect(host.querySelector<HTMLElement>('[data-market-panel="github"]')!.hidden).toBe(true)
    expect(host.querySelector('[data-manage-tab]')).not.toBeNull()
    await click(host.querySelector('[data-market-tab="github"]'))
    await flush()
    expect(host.querySelector<HTMLElement>('[data-market-panel="github"]')!.hidden).toBe(false)

    await act(async () => { queue[2]!.settle(pageOf(SEARCH_PAGE_SIZE, 12)) })
    await flush()
    expect(host.querySelector<HTMLButtonElement>('[data-market-refresh]')!.disabled).toBe(false)
    expect(host.querySelectorAll('[data-market-card]')).toHaveLength(SEARCH_PAGE_SIZE)
  })

  it('刷新按钮的 aria-label 与 title 都取自词典', async () => {
    const host = await openTab({ search: vi.fn(async () => makeSearchPage(items(1))) }, 'github')
    const refresh = host.querySelector<HTMLButtonElement>('[data-market-refresh]')!
    expect(refresh.getAttribute('aria-label')).toBe(zh.refreshButton)
    expect(refresh.getAttribute('title')).toBe(zh.refreshButton)
  })

  it('失败后按同一页重试仍是缓存读，随后刷新显式绕过缓存', async () => {
    const calls: { keywords: string; page: number; refresh: boolean | undefined }[] = []
    const outcomes: (GitHubSearchPage | Error)[] = [
      new MarketCallFailure({ code: 'github/network', message: 'down', details: {} }),
      makeSearchPage(items(3)),
      makeSearchPage(items(3)),
    ]
    const search = vi.fn(async (keywords: string, page: number, refresh?: boolean) => {
      calls.push({ keywords, page, refresh })
      const next = outcomes.shift()
      if (next instanceof Error) throw next
      return next!
    })
    const host = await openTab({ search }, 'github')

    expect(host.querySelector('[data-market-error]')).not.toBeNull()
    await click(host.querySelector('[data-market-retry]'))
    await flush()
    expect(calls[1]).toEqual({ keywords: '', page: 1, refresh: undefined })
    expect(host.querySelectorAll('[data-market-card]')).toHaveLength(3)

    await click(host.querySelector('[data-market-refresh]'))
    await flush()
    expect(calls[2]).toEqual({ keywords: '', page: 1, refresh: true })
  })

  it('详情刷新调用 repositoryDetail(slug, true)，打开详情与 data-detail-retry 为 undefined，Escape 返回不重发搜索', async () => {
    const search = vi.fn(async () => makeSearchPage(items(2)))
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({ repository }))
    const host = await openTab({ search, repositoryDetail }, 'github')

    await click(host.querySelector('[data-row-details]'))
    await flush()
    expect(repositoryDetail).toHaveBeenCalledTimes(1)
    expect(repositoryDetail.mock.calls[0]).toEqual(['octocat/repo-1', undefined])

    const detailRefresh = host.querySelector<HTMLButtonElement>('[data-detail-refresh]')!
    expect(detailRefresh.getAttribute('aria-label')).toBe(zh.detailRefreshButton)
    await click(detailRefresh)
    await flush()
    expect(repositoryDetail).toHaveBeenCalledTimes(2)
    expect(repositoryDetail.mock.calls[1]).toEqual(['octocat/repo-1', true])

    const searchCalls = search.mock.calls.length
    await pressKey(host.querySelector('[data-github-panel]'), 'Escape')
    await flush()
    expect(host.querySelector('[data-detail-pane]')).toBeNull()
    expect(search.mock.calls.length).toBe(searchCalls)
    expect(host.querySelectorAll('[data-market-card]')).toHaveLength(2)
  })

  it('详情加载失败后 data-detail-retry 重试不带 refresh', async () => {
    let attempt = 0
    const repositoryDetail = vi.fn(async (repository: string, _refresh?: boolean) => {
      attempt += 1
      if (attempt === 1) {
        throw new MarketCallFailure({ code: 'github/network', message: 'down', details: {} })
      }
      return makeRepositoryDetail({ repository })
    })
    const host = await openTab({
      search: vi.fn(async () => makeSearchPage(items(1))),
      repositoryDetail,
    }, 'github')
    await click(host.querySelector('[data-row-details]'))
    await flush()

    expect(host.querySelector('[data-detail-error]')).not.toBeNull()
    await click(host.querySelector('[data-detail-retry]'))
    await flush()
    expect(repositoryDetail).toHaveBeenCalledTimes(2)
    expect(repositoryDetail.mock.calls[1]).toEqual(['octocat/repo-1', undefined])
    expect(host.querySelector('[data-detail-error]')).toBeNull()
  })
})
describe('[离朱] 限流可选等待文案', () => {
  const t = makeTranslator('zh')

  it('单位换算与向上取整有 1 秒下界（纯函数边界）', () => {
    expect(rateLimitWaitText(1, t)).toBe('1 秒')
    expect(rateLimitWaitText(999, t)).toBe('1 秒')
    expect(rateLimitWaitText(1000, t)).toBe('1 秒')
    expect(rateLimitWaitText(1001, t)).toBe('2 秒')
    expect(rateLimitWaitText(59_999, t)).toBe('1 分钟')
    expect(rateLimitWaitText(60_000, t)).toBe('1 分钟')
    expect(rateLimitWaitText(120_000, t)).toBe('2 分钟')
    expect(rateLimitWaitText(3_600_000, t)).toBe('1 小时')
    expect(rateLimitWaitText(7_200_000, t)).toBe('2 小时')
  })

  it('仅 github/rate-limit 且 retryAfterMs 为正有限数时给出等待行', () => {
    expect(rateLimitWaitLine(failure('github/rate-limit', { retryAfterMs: 120_000 }), t))
      .toBe(zh.rateLimitWait.replace('{wait}', '2 分钟'))
    // 缺失 / 0 / 负数 / NaN / 字符串 / Infinity：一律不渲染等待行。
    for (const detail of [{}, { retryAfterMs: 0 }, { retryAfterMs: -1 }, { retryAfterMs: Number.NaN },
      { retryAfterMs: '60000' }, { retryAfterMs: Number.POSITIVE_INFINITY }]) {
      expect(rateLimitWaitLine(failure('github/rate-limit', detail), t), JSON.stringify(detail)).toBeNull()
    }
    // 其它失败码即便携带 retryAfterMs 也绝不出现等待行。
    expect(rateLimitWaitLine(failure('github/network', { retryAfterMs: 120_000 }), t)).toBeNull()
    expect(rateLimitWaitLine(failure('market/unreachable', { retryAfterMs: 120_000 }), t)).toBeNull()
  })

  it('未知来源标签回落为通用文案', () => {
    expect(tokenSourceText('file', t)).toBe(zh.tokenSourceFile)
    expect(tokenSourceText('env', t)).toBe(zh.tokenSourceEnv)
    expect(tokenSourceText('project-env', t)).toBe(zh.tokenSourceProjectEnv)
    expect(tokenSourceText('user-env', t)).toBe(zh.tokenSourceUserEnv)
    expect(tokenSourceText(undefined, t)).toBe(zh.tokenSourceOther)
    expect(tokenSourceText('keyring' as never, t)).toBe(zh.tokenSourceOther)
  })

  it('列表限流失败：等待行与固定限流文案并存，且挂在 data-market-error 之下', async () => {
    const search = vi.fn(async () => {
      throw new MarketCallFailure({
        code: 'github/rate-limit',
        message: 'limited',
        details: { retryAfterMs: 120_000 },
      })
    })
    const host = await openTab({ search }, 'github')

    const error = host.querySelector<HTMLElement>('[data-market-error]')!
    expect(error.textContent).toContain(zh.rateLimited)
    const wait = host.querySelector<HTMLElement>('[data-rate-limit-wait]')!
    expect(wait).not.toBeNull()
    expect(wait.parentElement).toBe(error)
    expect(wait.textContent).toBe(zh.rateLimitWait.replace('{wait}', '2 分钟'))
    // 失败态仍提供重试出口。
    expect(host.querySelector('[data-market-retry]')).not.toBeNull()
  })

  it('列表限流失败但 retryAfterMs 缺失/非法：只保留固定文案，不渲染等待节点', async () => {
    for (const detail of [{}, { retryAfterMs: 0 }, { retryAfterMs: 'soon' }]) {
      const search = vi.fn(async () => {
        throw new MarketCallFailure({ code: 'github/rate-limit', message: 'limited', details: detail })
      })
      const host = await openTab({ search }, 'github')
      expect(host.querySelector('[data-rate-limit-wait]'), JSON.stringify(detail)).toBeNull()
      expect(host.querySelector<HTMLElement>('[data-market-error]')!.textContent).toContain(zh.rateLimited)
      for (const root of roots.splice(0)) await act(async () => { root.unmount() })
      document.body.innerHTML = ''
    }
  })

  it('非限流失败即使携带 retryAfterMs 也不出现等待节点（详情视图同样成立）', async () => {
    const repositoryDetail = vi.fn(async () => {
      throw new MarketCallFailure({
        code: 'github/network',
        message: 'down',
        details: { retryAfterMs: 60_000 },
      })
    })
    const host = await openTab({
      search: vi.fn(async () => makeSearchPage(items(1))),
      repositoryDetail,
    }, 'github')
    await click(host.querySelector('[data-row-details]'))
    await flush()

    const error = host.querySelector<HTMLElement>('[data-detail-error]')!
    expect(error.getAttribute('data-error-code')).toBe('github/network')
    expect(error.textContent).toContain(zh.networkError)
    expect(host.querySelector('[data-rate-limit-wait]')).toBeNull()
  })

  it('详情视图的限流失败渲染同一等待行（小时单位）', async () => {
    const repositoryDetail = vi.fn(async () => {
      throw new MarketCallFailure({
        code: 'github/rate-limit',
        message: 'limited',
        details: { retryAfterMs: 3_600_000 },
      })
    })
    const host = await openTab({
      search: vi.fn(async () => makeSearchPage(items(1))),
      repositoryDetail,
    }, 'github')
    await click(host.querySelector('[data-row-details]'))
    await flush()

    const error = host.querySelector<HTMLElement>('[data-detail-error]')!
    expect(error.textContent).toContain(zh.rateLimited)
    const wait = host.querySelector<HTMLElement>('[data-rate-limit-wait]')!
    expect(wait.textContent).toBe(zh.rateLimitWait.replace('{wait}', '1 小时'))
    expect(wait.parentElement).toBe(error)
  })
})

describe('[离朱] 令牌读取失败不阻塞其它标签页', () => {
  it('无凭据服务的部署：令牌标签给出 load-error，本地标签仍完整渲染', async () => {
    const host = await openTab({
      status: vi.fn(async () => makeStatus(true, '/repo')),
      tokenStatus: vi.fn(async () => {
        throw new MarketCallFailure({ code: 'github/token-unavailable', message: 'no seam', details: {} })
      }),
    }, 'local')
    expect(host.querySelector('[data-market-status="configured"]')).not.toBeNull()

    await click(host.querySelector('[data-market-tab="token"]'))
    await flush()
    const loadError = host.querySelector<HTMLElement>('[data-token-load-error]')!
    expect(loadError.getAttribute('data-error-code')).toBe('github/token-unavailable')
    expect(loadError.textContent).toContain(zh.tokenLoadFailed)
    expect(loadError.textContent).toContain(zh.tokenErrorUnavailable)
    expect(host.querySelector('[data-token-body]')).toBeNull()

    // 回到本地标签：仓库状态行与花名册仍在（令牌页的失败没有破坏页面）。
    await click(host.querySelector('[data-market-tab="local"]'))
    await flush()
    expect(host.querySelector('[data-market-status="configured"]')).not.toBeNull()
    expect(host.querySelector('[data-manage-tab]')).not.toBeNull()
  })
})