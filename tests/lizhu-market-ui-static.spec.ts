/**
 * 离朱独立验证（静态契约，round 4：分类标签·3/3）
 *
 * 与力牧的组件规格相互独立的第二视角：不渲染组件，而是直接对
 * 1) ManagePluginsTab.module.css 的高度自适应契约（无 vh 上限、flex 归属）；
 * 2) locales.ts 的 zh/en 同键集与新增/删除词条；
 * 3) 组件/CSS 源码中不得存在硬编码用户可见文案（CJK 字面量）
 * 做断言。纯静态分析，不依赖 jsdom 布局能力（jsdom 不做布局）。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

const cssUrl = new URL('../src/client/ManagePluginsTab.module.css', import.meta.url)
const tsxUrl = new URL('../src/client/ManagePluginsTab.tsx', import.meta.url)

const rawCss = readFileSync(cssUrl, 'utf8')

/** Drop comments so a prose brace never confuses the rule parser. */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

interface Rule {
  selector: string
  body: string
}

const RULES: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
  selector: match[1]!.trim().replace(/\s+/g, ' '),
  body: match[2]!,
}))

/** Every rule whose selector list mentions the given class verbatim. */
function rulesFor(className: string): Rule[] {
  return RULES.filter(rule =>
    rule.selector.split(',').some(part => part.trim() === className))
}

function declarationOf(className: string, property: string): string | null {
  const rules = rulesFor(className)
  expect(rules.length, `no CSS rule declares ${className}`).toBeGreaterThan(0)
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i')
  for (const rule of rules) {
    const found = pattern.exec(rule.body)
    if (found !== null) return found[1]!.trim()
  }
  return null
}

describe('[离朱] 高度自适应 CSS 契约', () => {
  it('page 根部是 100% 高度的纵向 flex 列且可收缩', () => {
    expect(declarationOf('.page', 'height')).toBe('100%')
    expect(declarationOf('.page', 'display')).toBe('flex')
    expect(declarationOf('.page', 'flex-direction')).toBe('column')
    expect(declarationOf('.page', 'min-height')).toBe('0')
  })

  it('两个 panel 与 tab 体各自拥有剩余高度（flex:1 1 auto + min-height:0）', () => {
    for (const className of ['.panel', '.localPanel', '.githubPanel']) {
      expect(declarationOf(className, 'flex'), className).toBe('1 1 auto')
      expect(declarationOf(className, 'min-height'), className).toBe('0')
    }
  })

  it('结果区 / README 区是 flex:1 1 auto + min-height:0 的滚动容器', () => {
    for (const className of ['.marketScroll', '.readmeSection']) {
      expect(declarationOf(className, 'flex'), className).toBe('1 1 auto')
      expect(declarationOf(className, 'min-height'), className).toBe('0')
      expect(declarationOf(className, 'overflow-y'), className).toBe('auto')
    }
  })

  it('详情区在 CSS 里保留 min-height:0（flex 由组件内联补齐）', () => {
    for (const className of ['.detailScroll', '.detailBody']) {
      expect(declarationOf(className, 'min-height'), className).toBe('0')
    }
  })

  it('tab 链与工具栏显式 flex:none，其余固定行也绝不吸收剩余高度', () => {
    for (const className of ['.tabs', '.toolbar']) {
      expect(declarationOf(className, 'flex'), className).toBe('none')
    }
    // 搜索表单 / 分页 footer / 工具栏行：要么显式 flex:none，要么依赖默认
    // flex-grow:0 —— 无论哪条路径，它们的 flex-grow 都不允许为正，否则会
    // 与滚动区争夺剩余高度（这正是不参与伸缩的可观测含义）。
    for (const className of ['.searchForm', '.pagination', '.pageToolbar']) {
      const flex = declarationOf(className, 'flex')
      if (flex !== null) expect(flex, className).toBe('none')
      const grow = declarationOf(className, 'flex-grow')
      if (grow !== null) expect(Number(grow), className).toBe(0)
    }
  })

  it('结果区 / 详情 / README / 列表体没有任何 vh 高度上限', () => {
    const guarded = [
      '.page', '.panel', '.localPanel', '.githubPanel',
      '.marketScroll', '.detailScroll', '.detailBody', '.readmeSection',
      '.resultList', '.list',
    ]
    for (const className of guarded) {
      for (const rule of rulesFor(className)) {
        expect(/\d\s*vh/.test(rule.body), `${className} carries a vh cap: ${rule.body}`).toBe(false)
        expect(/(?:^|;)\s*max-height\s*:/i.test(rule.body), `${className} carries max-height`).toBe(false)
      }
    }
  })

  it('全文件仅弹窗外壳允许 vh 上限（46vh 已彻底消失）', () => {
    const offending = RULES.filter(rule => /\d\s*vh/.test(rule.body))
    expect(offending.map(rule => rule.selector)).toEqual(['.dialog'])
    expect(css).not.toMatch(/46\s*vh/)
  })
})

describe('[离朱] locales 词典契约', () => {
  it('zh 与 en 是同键集（编译期约束的运行时复核）', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('新增分类/文案词条齐备且 zh/en 逐键对齐', () => {
    expect(zh.classificationPlugin).toBe('插件')
    expect(zh.classificationSkills).toBe('SKILLS')
    expect(zh.classificationOther).toBe('其他')
    expect(en.classificationPlugin).toBe('Plugin')
    expect(en.classificationSkills).toBe('SKILLS')
    expect(en.classificationOther).toBe('Other')
    expect(zh.switchNotLoadable).toContain('{name}')
    expect(en.switchNotLoadable).toContain('{name}')
    expect(zh.classificationNotice).toContain('{classification}')
    expect(en.classificationNotice).toContain('{classification}')
    expect(zh.buildRequiredNotice.length).toBeGreaterThan(0)
    expect(en.buildRequiredNotice.length).toBeGreaterThan(0)
  })

  it('已删除词条不再残留在任何一本词典里', () => {
    const removed = [
      'installedBadge',
      'analysisKindBuild', 'analysisKindSkills', 'analysisKindPreset',
      'analysisKindTooling', 'analysisKindOther',
    ]
    const zhKeys = new Set(Object.keys(zh))
    const enKeys = new Set(Object.keys(en))
    for (const key of removed) {
      expect(zhKeys.has(key), `zh still carries ${key}`).toBe(false)
      expect(enKeys.has(key), `en still carries ${key}`).toBe(false)
    }
    // 「已下载」这一措辞本身也不得再出现在任何词条值里。
    for (const value of [...Object.values(zh), ...Object.values(en)]) {
      expect(value).not.toContain('已下载')
    }
  })
})

describe('[离朱] 无硬编码用户可见文案', () => {
  it('组件与样式表源码里没有 CJK 字面量（文案一律经 t()/词典）', () => {
    for (const url of [tsxUrl, cssUrl]) {
      const source = readFileSync(url, 'utf8')
      const cjk = source.match(/[\u4e00-\u9fff]/g)
      expect(cjk, `${url.pathname} carries hardcoded CJK copy`).toBeNull()
    }
  })

  it('组件源码不再出现旧拒绝面板与已下载徽标的实现痕迹', () => {
    const source = readFileSync(tsxUrl, 'utf8')
    for (const marker of [
      'data-analysis-blocked', 'data-analysis-title', 'data-analysis-reason',
      'data-ref-installed', 'data-installed', 'installedBadge',
      'analysisKindBuild', 'analysisKindSkills', 'analysisKindPreset',
      'analysisKindTooling', 'analysisKindOther',
    ]) {
      expect(source.includes(marker), `component still carries ${marker}`).toBe(false)
    }
  })
})
