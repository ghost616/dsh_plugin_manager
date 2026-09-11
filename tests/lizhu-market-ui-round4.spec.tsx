// @vitest-environment jsdom
/**
 * 离朱独立验证（组件层，round 4：分类标签·3/3）
 *
 * 目标功能说明的 6 个条目逐条独立复核：
 *  1) 整页高度自适应父容器（内联样式契约，DOM 侧）；
 *  2) 下载入口不再检测「已下载/已安装」，且既有记录的 ref 仍可下载；
 *  3) 下载确认框展示 classification，旧分析拒绝面板已移除；
 *  4) 本地仓库列表分类标签与启停禁用；
 *  5) 文案（见 lizhu-market-ui-static.spec.ts）；
 *  6) 构建产物（见执行报告中的 lib/client.js 残留字面量扫描）。
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { ManagedPluginList, PluginMarketKey, PluginMarketRecord } from '../src/types.ts'
import { zh } from '../src/client/locales.ts'
import { MarketCallFailure } from '../src/client/channel.ts'
import { ManagePluginsTab, type ManagePluginsTabInjected } from '../src/client/ManagePluginsTab.tsx'
import {
  makeCommit,
  makeInstallReview,
  makeList,
  makePreparation,
  makeRepositoryDetail,
  makeSearchPage,
  makeVerdict,
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

function pageOf(page: number, items: SearchItemSeed[], totalCount: number) {
  const pageData = makeSearchPage(items)
  return { totalCount, items: pageData.items }
}

function panelOf(host: HTMLElement): HTMLElement {
  const panel = host.querySelector('[data-github-panel]')
  if (panel === null) throw new Error('the GitHub panel is not mounted')
  return panel as HTMLElement
}

async function openMarket(host: HTMLElement): Promise<HTMLElement> {
  await click(host.querySelector('[data-market-tab="github"]'))
  await flush()
  return panelOf(host)
}

async function searchIn(dialog: HTMLElement, keywords: string): Promise<void> {
  const input = dialog.querySelector<HTMLInputElement>('[data-market-search-input]')!
  await typeInto(input, keywords)
  submitForm(input)
  await flush()
}

function el(host: HTMLElement, selector: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(selector)
  if (found === null) throw new Error(`missing ${selector}`)
  return found
}

/* ------------------------------------------------------------------------ */
/* 1. 整页高度自适应父容器                                                   */
/* ------------------------------------------------------------------------ */

describe('[离朱] 1. 整页高度自适应父容器', () => {
  it('页面根与两个面板以内联样式铺满宿主高度，且都不撑破父容器', async () => {
    const search = vi.fn(async (_keywords: string, page: number) => pageOf(page, [
      { repository: 'acme/helper', name: 'helper' },
    ], 1))
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: [],
      readme: '# Overview\n\nlong body',
    }))
    const { props } = managePageHarness({ search, repositoryDetail })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const page = el(host, '[data-market-page]')
    expect(page.style.height).toBe('100%')
    expect(page.style.minHeight).toBe('0px')

    const panels = Array.from(host.querySelectorAll<HTMLElement>('[data-market-panel]'))
    expect(panels.map(panel => panel.getAttribute('data-market-panel'))).toEqual(['local', 'github', 'token'])
    for (const panel of panels) {
      expect(panel.style.flex).toBe('1 1 auto')
      expect(panel.style.minHeight).toBe('0px')
    }

    // 本地列表体是本地页签自己的滚动区。
    const localBody = el(host, '[data-manage-tab]')
    expect(localBody.style.flex).toBe('1 1 auto')
    expect(localBody.style.minHeight).toBe('0px')

    const market = await openMarket(host)
    await searchIn(market, 'helper')
    expect(el(host, '[data-github-panel]').style.flex).toBe('1 1 auto')

    // 结果区：只有剩余高度，没有任何 vh/max-height 上限。
    const scrollZone = el(host, '[data-market-scroll]')
    expect(scrollZone.style.flex).toBe('1 1 auto')
    expect(scrollZone.style.minHeight).toBe('0px')
    expect(scrollZone.style.maxHeight).toBe('')
    expect(scrollZone.style.height).toBe('')

    // 搜索表单与分页 footer 保持 flex:none（不参与伸缩）。
    const form = el(host, '[data-github-search]')
    expect(form.style.flexGrow).toBe('')
    expect(form.style.maxHeight).toBe('')
    const pagination = el(host, '[data-pagination]')
    expect(pagination.style.flexGrow).toBe('')
    expect(pagination.style.maxHeight).toBe('')

    // 详情区三件套同样是 flex:1 1 auto + min-height:0。
    await click(host.querySelector('[data-row-details]'))
    await flush()
    for (const selector of ['[data-detail-scroll]', '[data-detail-view]', '[data-readme-section]']) {
      const node = el(host, selector)
      expect(node.style.flex, selector).toBe('1 1 auto')
      expect(node.style.minHeight, selector).toBe('0px')
      expect(node.style.maxHeight, selector).toBe('')
    }
    // 详情头部不参与伸缩，也不带任何高度上限。
    const detailHeader = el(host, '[data-github-detail-header]')
    expect(detailHeader.style.maxHeight).toBe('')
    expect(detailHeader.style.flexGrow).toBe('')
  })
})

/* ------------------------------------------------------------------------ */
/* 2. 下载入口不再检测「已下载/已安装」                                      */
/* ------------------------------------------------------------------------ */

describe('[离朱] 2. 下载入口不再检测已下载/已安装', () => {
  function existingRecordHarness(exists: boolean) {
    const list = vi.fn(async () => makeList([
      { key: 'gh-acme-helper', repository: 'acme/helper', version: 'v1.0.0', enabled: false },
    ]))
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository,
      branches: ['main'],
      tags: ['v1.0.0', 'v2.0.0'],
    }))
    const previewInstall = vi.fn(async (repository: string, version?: string | null) =>
      makeInstallReview({ repository, ...(typeof version === 'string' ? { version } : {}), exists }))
    // The staged download the page now drives: clone → classify → commit.
    const prepareDownload = vi.fn(async (repository: string) => makePreparation({
      repository,
      token: 'dl-acme-helper',
      version: 'v1.0.0',
      refKind: 'tag',
      overwrite: exists,
    }))
    const classifyDownload = vi.fn(async () => makeVerdict({ classification: 'plugin' }))
    const commitDownload = vi.fn(async (repository: string, version: string | null = null) =>
      makeCommit({
        repository,
        token: 'dl-acme-helper',
        version,
        refKind: 'tag',
        overwritten: exists,
      }))
    const { props } = managePageHarness({
      list, search, repositoryDetail, previewInstall, prepareDownload, classifyDownload, commitDownload,
    })
    return { props, previewInstall, commitDownload }
  }

  it('结果卡没有已下载徽标，且每行都有可用的详情入口', async () => {
    const { props } = existingRecordHarness(true)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const market = await openMarket(host)
    await searchIn(market, 'helper')

    const card = el(host, '[data-market-card]')
    expect(card.getAttribute('data-repository')).toBe('acme/helper')
    expect(card.querySelector('[data-installed]')).toBeNull()
    expect(card.textContent).not.toContain('已下载')
    expect(card.querySelector('[data-row-details]')).not.toBeNull()
    expect((card.querySelector('[data-row-details]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('ref 下拉对既有记录不做任何标注，选中既有 ref 后仍可下载并走完确认流', async () => {
    const { props, previewInstall, commitDownload } = existingRecordHarness(true)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const market = await openMarket(host)
    await searchIn(market, 'helper')
    await click(host.querySelector('[data-row-details]'))
    await flush()

    const select = el(host, '[data-ref-select]')
    expect(select.querySelectorAll('[data-ref-installed]')).toHaveLength(0)
    expect(select.querySelector('option[data-ref-name="v1.0.0"]')?.getAttribute('data-ref-installed')).toBeNull()
    expect(select.textContent).not.toContain('已安装')

    // 未选 ref 时禁用，文案仍是「下载」。
    const action = el(host, '[data-ref-install]') as HTMLButtonElement
    expect(action.disabled).toBe(true)
    expect(action.textContent).toContain(zh.downloadButton)

    // 选中「对应既有记录」的 ref：仍可点、仍叫「下载」，点击真的发起预览。
    await selectIn(select, 'tag:v1.0.0')
    await flush()
    expect(action.disabled).toBe(false)
    expect(action.textContent).toContain(zh.downloadButton)

    await click(action)
    await flush()
    expect(previewInstall).toHaveBeenCalledTimes(1)
    expect(previewInstall).toHaveBeenCalledWith('acme/helper', 'v1.0.0', 'tag')

    const dialog = el(host, '[data-dialog="install"]')
    // 既有记录改由覆盖提示表达，而不是禁用下载入口。
    expect(dialog.querySelector('[data-overwrite-notice]')).not.toBeNull()
    const confirm = dialog.querySelector('[data-install-confirm]') as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    await click(confirm)
    await flush()
    // 三阶段走完，既有检出被换入（overwritten）。
    expect(commitDownload).toHaveBeenCalledWith('dl-acme-helper', 'plugin')
    expect(dialog.querySelector('[data-install-done]')).not.toBeNull()
  })

  it('未安装过的新仓库与既有仓库走同一条下载路径（无分支差异）', async () => {
    const { props, previewInstall, commitDownload } = existingRecordHarness(false)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const market = await openMarket(host)
    await searchIn(market, 'helper')
    await click(host.querySelector('[data-row-details]'))
    await flush()
    await selectIn(host.querySelector('[data-ref-select]'), 'branch:main')
    await flush()
    await click(host.querySelector('[data-ref-install]'))
    await flush()
    expect(previewInstall).toHaveBeenCalledWith('acme/helper', 'main', 'branch')
    const dialog = el(host, '[data-dialog="install"]')
    expect(dialog.querySelector('[data-overwrite-notice]')).toBeNull()
    await click(dialog.querySelector('[data-install-confirm]'))
    await flush()
    expect(commitDownload).toHaveBeenCalledTimes(1)
    expect(dialog.querySelector('[data-install-done]')).not.toBeNull()
  })
})

/* ------------------------------------------------------------------------ */
/* 3. 下载确认框展示 classification，旧拒绝面板已移除                        */
/* ------------------------------------------------------------------------ */

describe('[离朱] 3. 下载确认框分类展示与旧拒绝面板移除', () => {
  function harness(previewInstall: ManagePluginsTabInjected['previewInstall']) {
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const repositoryDetail = vi.fn(async (repository: string) => makeRepositoryDetail({
      repository, branches: ['main'], tags: [],
    }))
    const install = vi.fn(async (repository: string, _token: string, version: string | null = null) =>
      makeCommit({ repository, ...(typeof version === 'string' ? { version } : {}) }))
    const { props } = managePageHarness({ search, repositoryDetail, previewInstall, commitDownload: install })
    return { props, install }
  }

  async function openInstall(host: HTMLElement): Promise<HTMLElement> {
    const market = await openMarket(host)
    await searchIn(market, 'helper')
    await click(host.querySelector('[data-row-details]'))
    await flush()
    await selectIn(host.querySelector('[data-ref-select]'), 'branch:main')
    await flush()
    await click(host.querySelector('[data-ref-install]'))
    await flush()
    return el(host, '[data-dialog="install"]')
  }

  it.each([
    ['plugin', zh.classificationPlugin],
    ['skills', zh.classificationSkills],
    ['other', zh.classificationOther],
  ] as const)('三种 classification（%s）都公告分类且确认键可用、下载可达 done', async (classification, expected) => {
    const previewInstall = vi.fn(async (repository: string, version?: string | null) =>
      makeInstallReview({ repository, ...(typeof version === 'string' ? { version } : {}), classification }))
    const { props, install } = harness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openInstall(host)

    expect(el(host, '[data-download-classification]').textContent)
      .toBe(zh.classificationNotice.replace('{classification}', expected))
    // 旧拒绝面板在任何分类下都不得出现，更不得取代确认流。
    for (const marker of ['[data-analysis-blocked]', '[data-analysis-title]', '[data-analysis-reason]']) {
      expect(dialog.querySelector(marker), marker).toBeNull()
    }
    const confirm = dialog.querySelector('[data-install-confirm]') as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    await click(confirm)
    await flush()
    expect(install).toHaveBeenCalledTimes(1)
    expect(dialog.querySelector('[data-install-done]')).not.toBeNull()
  })

  it.each([
    ['skills'], ['plugin'], ['tooling'], ['preset'], ['other'],
  ] as const)('分析结论 kind=%s 时旧拒绝面板依然不出现，下载不被阻断', async (kind) => {
    const reason = `analyzer verdict: ${kind}`
    const previewInstall = vi.fn(async (repository: string, version?: string | null) =>
      makeInstallReview({
        repository,
        ...(typeof version === 'string' ? { version } : {}),
        analysis: { kind, reason },
        entryNote: reason,
      }))
    const { props, install } = harness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openInstall(host)

    expect(dialog.querySelector('[data-analysis-blocked]')).toBeNull()
    expect(dialog.querySelector('[data-analysis-title]')).toBeNull()
    expect(dialog.querySelector('[data-analysis-reason]')).toBeNull()
    expect(dialog.querySelector('[data-install-confirm]')).not.toBeNull()
    expect(el(host, '[data-download-classification]').textContent)
      .toContain(zh.classificationNotice.replace('{classification}', ''))
    await click(dialog.querySelector('[data-install-confirm]'))
    await flush()
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('结构化 note 的词典文案、引擎明细与 buildRequired 提示各自渲染在独立节点上', async () => {
    // The host ships a stable note kind (no prose) plus an engine-supplied
    // detail: the tab renders its own dictionary copy for the kind and keeps
    // the untrusted detail on a secondary node.
    const detail = 'No runnable entry "dist/index.js" is present in the checkout yet.'
    const previewInstall = vi.fn(async (repository: string, version?: string | null) =>
      makeInstallReview({
        repository,
        ...(typeof version === 'string' ? { version } : {}),
        classification: 'other',
        note: { kind: 'entry-missing', text: detail, entry: 'dist/index.js' },
        buildRequired: true,
      }))
    const { props } = harness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openInstall(host)
    // The note line carries the dictionary copy for the kind plus the
    // expected-entry template fed by the host's `note.entry`.
    const noteText = el(host, '[data-classification-note]').textContent ?? ''
    expect(noteText).toContain(zh.entryMissingNote)
    expect(noteText).toContain(zh.expectedEntryNote.replace('{entry}', 'dist/index.js'))
    expect(el(host, '[data-classification-detail]').textContent).toBe(detail)
    expect(el(host, '[data-build-required]').textContent).toContain(zh.buildRequiredNotice)
    expect(dialog.querySelector('[data-install-confirm]')).not.toBeNull()
  })

  it('debug 专用的 entryNote 字符串不会渲染为用户可见文案', async () => {
    const diagnostic = 'The resolved plugin entry "index.js" does not exist inside the checkout.'
    const previewInstall = vi.fn(async (repository: string, version?: string | null) =>
      makeInstallReview({
        repository,
        ...(typeof version === 'string' ? { version } : {}),
        classification: 'other',
        entryNote: diagnostic,
      }))
    const { props } = harness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openInstall(host)
    expect(dialog.querySelector('[data-classification-note]')).toBeNull()
    expect(dialog.querySelector('[data-classification-detail]')).toBeNull()
    expect(dialog.textContent).not.toContain(diagnostic)
    expect(dialog.querySelector('[data-install-confirm]')).not.toBeNull()
  })

  it.each([
    ['market/llm-unconfigured', zh.analysisNotConfigured, false],
    ['market/llm-failed', zh.analysisModelFailed, true],
    ['market/llm-bad-output', zh.analysisBadOutput, true],
  ] as const)('分析族预览失败 %s：专用文案、不叠加 previewFailed、闭环可退出', async (code, copy, retryable) => {
    const previewInstall = vi.fn()
      .mockRejectedValueOnce(new MarketCallFailure({ code, message: 'trouble', details: {} }))
      .mockResolvedValueOnce(makeInstallReview({ repository: 'acme/helper', version: 'main' }))
    const { props, install } = harness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openInstall(host)

    const error = el(host, '[data-preview-error]')
    expect(error.getAttribute('data-error-code')).toBe(code)
    expect(error.textContent).toContain(copy)
    expect(error.textContent).not.toContain(zh.previewFailed)
    expect(dialog.querySelector('[data-install-confirm]')).toBeNull()
    expect(install).not.toHaveBeenCalled()

    if (retryable) {
      expect(dialog.querySelector('[data-preview-retry]')).not.toBeNull()
      expect(dialog.querySelector('[data-analysis-guide]')).toBeNull()
      await click(dialog.querySelector('[data-preview-retry]'))
      await flush()
      expect(dialog.querySelector('[data-preview-error]')).toBeNull()
      expect(dialog.querySelector('[data-install-confirm]')).not.toBeNull()
    } else {
      // 配置缺失不可在此重试：只有配置引导 + 关闭。
      expect(dialog.querySelector('[data-preview-retry]')).toBeNull()
      expect(el(host, '[data-analysis-guide]').textContent).toContain(zh.analysisConfigGuide)
      await click(dialog.querySelector('[data-analysis-close]'))
      await flush()
      expect(host.querySelector('[data-dialog="install"]')).toBeNull()
    }
  })

  it('非分析族预览失败仍带通用前缀且提供取消（不是分析关闭）', async () => {
    const previewInstall = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'github/bad-response', message: 'bad body', details: {} })
    })
    const { props } = harness(previewInstall)
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const dialog = await openInstall(host)

    const error = el(host, '[data-preview-error]')
    expect(error.getAttribute('data-error-code')).toBe('github/bad-response')
    expect(error.textContent).toContain(zh.previewFailed)
    expect(dialog.querySelector('[data-analysis-guide]')).toBeNull()
    expect(dialog.querySelector('[data-preview-retry]')).not.toBeNull()
    expect(dialog.querySelector('[data-analysis-close]')).toBeNull()
    expect(dialog.querySelector('[data-dialog-cancel]')).not.toBeNull()
    await click(dialog.querySelector('[data-dialog-cancel]'))
    await flush()
    expect(host.querySelector('[data-dialog="install"]')).toBeNull()
  })
})

/* ------------------------------------------------------------------------ */
/* 4. 本地仓库列表分类标签与启停禁用                                         */
/* ------------------------------------------------------------------------ */

describe('[离朱] 4. 本地仓库列表分类标签与启停禁用', () => {
  it('混合行：标签/可加载性正确，非 plugin 与无入口行的开关禁用且点击无效，plugin 行照常切换', async () => {
    let snapshot: ManagedPluginList = makeList([
      { key: 'gh-plugin', repository: 'acme/plugin', enabled: false },
      { key: 'gh-skills', repository: 'acme/skills-pack', classification: 'skills' },
      { key: 'gh-other', repository: 'acme/preset', classification: 'other' },
      { key: 'gh-unbuilt', repository: 'acme/unbuilt', classification: 'plugin', entry: null },
    ])
    const list = vi.fn(async () => snapshot)
    const setEnabled = vi.fn(async (key: PluginMarketKey, enabled: boolean): Promise<PluginMarketRecord> => {
      const target = snapshot.entries.find(entry => entry.key === key)!
      const record: PluginMarketRecord = { ...target.record, enabled }
      snapshot = {
        entries: snapshot.entries.map(entry => (entry.key === key
          ? { ...entry, record, runtime: { ...entry.runtime, disabled: !enabled } }
          : entry)),
      }
      return record
    })
    const { props } = managePageHarness({ list, setEnabled })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-plugin-row]'))
    expect(rows).toHaveLength(4)
    expect(rows.map(row => row.getAttribute('data-classification')))
      .toEqual(['plugin', 'skills', 'other', 'plugin'])
    expect(rows.map(row => row.getAttribute('data-loadable')))
      .toEqual(['true', 'false', 'false', 'false'])

    const tags = Array.from(host.querySelectorAll<HTMLElement>('[data-classification-tag]'))
    expect(tags.map(tag => tag.textContent))
      .toEqual([zh.classificationPlugin, zh.classificationSkills, zh.classificationOther, zh.classificationPlugin])
    expect(tags.map(tag => tag.getAttribute('data-kind')))
      .toEqual(['plugin', 'skills', 'other', 'plugin'])

    const toggles = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-plugin-toggle]'))
    expect(toggles[0]!.disabled).toBe(false)
    expect(toggles[1]!.disabled).toBe(true)
    expect(toggles[1]!.getAttribute('data-not-loadable')).toBe('classification')
    expect(toggles[2]!.disabled).toBe(true)
    expect(toggles[2]!.getAttribute('data-not-loadable')).toBe('classification')
    expect(toggles[3]!.disabled).toBe(true)
    expect(toggles[3]!.getAttribute('data-not-loadable')).toBe('entry')

    // aria-label/title 与行内提示同一句话（开关与行注一致）。两种门禁原因各
    // 有自己的句子：分类原因走 switchNotLoadable，缺入口原因走
    // switchNotLoadableEntry（清理批拆分）。
    for (const [index, copy] of [
      [1, zh.switchNotLoadable.replace('{name}', 'acme/skills-pack')],
      [2, zh.switchNotLoadable.replace('{name}', 'acme/preset')],
      [3, zh.switchNotLoadableEntry.replace('{name}', 'acme/unbuilt')],
    ] as const) {
      expect(toggles[index]!.getAttribute('aria-label')).toBe(copy)
      expect(toggles[index]!.getAttribute('title')).toBe(copy)
    }
    const notes = Array.from(host.querySelectorAll<HTMLElement>('[data-toggle-disabled-note]'))
    expect(notes.map(note => note.textContent)).toEqual([
      zh.switchNotLoadable.replace('{name}', 'acme/skills-pack'),
      zh.switchNotLoadable.replace('{name}', 'acme/preset'),
      zh.switchNotLoadableEntry.replace('{name}', 'acme/unbuilt'),
    ])

    // 点击禁用开关绝对不触发宿主调用。
    await click(toggles[1])
    await click(toggles[2])
    await click(toggles[3])
    await flush()
    expect(setEnabled).not.toHaveBeenCalled()

    // 同一页里可加载的 plugin 行依旧可切换（成功回写 + 重读）。
    await click(toggles[0])
    await flush()
    expect(setEnabled).toHaveBeenCalledWith('gh-plugin', true)
    expect(list).toHaveBeenCalledTimes(2)
    expect(Array.from(host.querySelectorAll<HTMLElement>('[data-plugin-row]'))[0]!
      .getAttribute('data-plugin-state')).toBe('enabled')
  })

  it('行内只有移除与启停两个控件，没有新增安装按钮或已下载徽标', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-a', repository: 'acme/a', enabled: true },
      { key: 'gh-b', repository: 'acme/b', classification: 'skills' },
    ]))
    const { props } = managePageHarness({ list })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    for (const row of Array.from(host.querySelectorAll<HTMLElement>('[data-plugin-row]'))) {
      const controls = Array.from(row.querySelectorAll('button'))
      // 移除 + 启停 + 分类标签（标签本身是可点的「人工修正」入口，不算新增安装按钮）。
      expect(controls).toHaveLength(3)
      for (const control of controls) {
        expect(
          control.hasAttribute('data-remove-trigger')
          || control.hasAttribute('data-plugin-toggle')
          || control.hasAttribute('data-classification-tag'),
        ).toBe(true)
      }
      expect(row.querySelector('[data-install-trigger]')).toBeNull()
      expect(row.querySelector('[data-installed]')).toBeNull()
      expect(row.textContent).not.toContain('已下载')
    }
  })

  it('切换失败时保留旧态并内联报错；失败不污染同级禁用行', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-a', repository: 'acme/a', enabled: false },
      { key: 'gh-b', repository: 'acme/b', classification: 'other' },
    ]))
    const setEnabled = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'market/not-loadable', message: 'nope', details: {} })
    })
    const { props } = managePageHarness({ list, setEnabled })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    await click(host.querySelector('[data-plugin-toggle]'))
    await flush()
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-plugin-row]'))
    expect(rows[0]!.getAttribute('data-plugin-state')).toBe('disabled')
    expect(rows[0]!.querySelector('[data-toggle-error]')?.getAttribute('data-error-code'))
      .toBe('market/not-loadable')
    expect(rows[1]!.querySelector('[data-toggle-error]')).toBeNull()
    expect((rows[1]!.querySelector('[data-plugin-toggle]') as HTMLButtonElement).disabled).toBe(true)
  })
})
