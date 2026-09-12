// @vitest-environment jsdom
/**
 * Component spec of the plugin-market settings page's local-repository tab:
 * the page-level tab strip, status header, enable toggles, roster states, and
 * unmount hygiene.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { GitHubTokenUpdateResult, ManagedPluginList, PluginMarketKey, PluginMarketRecord } from '../src/types.ts'
import { zh } from '../src/client/locales.ts'
import { MarketCallFailure } from '../src/client/channel.ts'
import { ManagePluginsTab } from '../src/client/ManagePluginsTab.tsx'
import {
  makeList,
  makeSearchPage,
  makeTokenStatus,
  makeTokenUpdate,
  makeTranslator,
  makeView,
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

/** Dispatch one keyboard event on a target (bubbles to its dialog shell). */
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

function rows(host: HTMLElement): NodeListOf<HTMLElement> {
  return host.querySelectorAll<HTMLElement>('[data-plugin-row]')
}

function toggles(host: HTMLElement): NodeListOf<HTMLButtonElement> {
  return host.querySelectorAll<HTMLButtonElement>('[data-plugin-toggle]')
}

describe('ManagePluginsTab page tabs', () => {
  it('renders the three localized tabs over the panels, landing on the local repository', async () => {
    const { props } = managePageHarness({
      list: vi.fn(async () => makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }])),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const tablist = host.querySelector('[role="tablist"]')
    expect(tablist?.getAttribute('aria-label')).toBe(zh.tabsLabel)
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-market-tab]'))
    expect(tabs.map(tab => tab.getAttribute('data-market-tab'))).toEqual(['local', 'github', 'token'])
    expect(tabs.map(tab => tab.textContent)).toEqual([zh.tabLocal, zh.tabGithub, zh.tabToken])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false')
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('false')
    // Only the selected tab is in the tab order (arrow keys move between them).
    expect(tabs[0]!.tabIndex).toBe(0)
    expect(tabs[1]!.tabIndex).toBe(-1)
    expect(tabs[2]!.tabIndex).toBe(-1)

    const panels = Array.from(host.querySelectorAll<HTMLElement>('[data-market-panel]'))
    expect(panels.map(panel => panel.getAttribute('data-market-panel'))).toEqual(['local', 'github', 'token'])
    expect(panels[0]!.hidden).toBe(false)
    expect(panels[1]!.hidden).toBe(true)
    expect(panels[2]!.hidden).toBe(true)
    expect(panels[0]!.getAttribute('aria-labelledby')).toBe(tabs[0]!.id)
    // The inactive panels are REPLACEMENTS, not stacked siblings: they are taken
    // out of the layout outright rather than left as invisible blocks below the
    // active one. The rule is pinned inline, so no host stylesheet can
    // re-introduce a display value for a hidden panel.
    expect(panels[1]!.style.display).toBe('none')
    expect(panels[2]!.style.display).toBe('none')
    expect(panels[0]!.style.display).toBe('')
    expect(panels.filter(panel => panel.style.display !== 'none')).toHaveLength(1)
    // The local repository owns the landed panel: its roster is up.
    expect(host.querySelector('[data-manage-tab]')).not.toBeNull()
    expect(host.querySelector('[data-plugin-row]')).not.toBeNull()
  })

  it('keeps exactly one panel in the layout after switching tabs', async () => {
    const { props } = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    await click(host.querySelector('[data-market-tab="github"]'))
    await flush()
    const local = host.querySelector<HTMLElement>('[data-market-panel="local"]')!
    const github = host.querySelector<HTMLElement>('[data-market-panel="github"]')!
    expect(local.hidden).toBe(true)
    expect(local.style.display).toBe('none')
    expect(github.hidden).toBe(false)
    expect(github.style.display).toBe('')
    // Still exactly one panel occupies layout space in each direction.
    expect(host.querySelectorAll<HTMLElement>('[data-market-panel]:not([style*="display: none"])')).toHaveLength(1)

    await click(host.querySelector('[data-market-tab="local"]'))
    await flush()
    expect(host.querySelector<HTMLElement>('[data-market-panel="local"]')!.style.display).toBe('')
    expect(host.querySelector<HTMLElement>('[data-market-panel="github"]')!.style.display).toBe('none')
    expect(host.querySelectorAll<HTMLElement>('[data-market-panel]:not([style*="display: none"])')).toHaveLength(1)
  })

  it('switches to the GitHub tab, browsing once, and keeps its results while hidden', async () => {
    const search = vi.fn(async () => makeSearchPage([
      { repository: 'acme/helper', name: 'helper' },
    ]))
    const { props } = managePageHarness({ search })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    // The GitHub panel mounts only when its tab is first selected.
    expect(search).not.toHaveBeenCalled()

    const tab = (id: string): HTMLButtonElement =>
      host.querySelector<HTMLButtonElement>(`[data-market-tab="${id}"]`)!
    await click(tab('github'))
    await flush()

    expect(search).toHaveBeenCalledTimes(1)
    // The ambient read carries no refresh: only the explicit refresh button asks
    // for a cache-bypassing read (the third argument is the refresh flag).
    expect(search).toHaveBeenCalledWith('', 1, undefined)
    expect(tab('github').getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector<HTMLElement>('[data-market-panel="github"]')!.hidden).toBe(false)
    expect(host.querySelector<HTMLElement>('[data-market-panel="local"]')!.hidden).toBe(true)
    expect(host.querySelector('[data-github-panel] [data-market-card]')?.textContent).toContain('helper')

    // Switching back hides the GitHub panel without unmounting it: the results
    // (and the auto-browse it already ran) survive the round trip.
    await click(tab('local'))
    await flush()
    expect(host.querySelector<HTMLElement>('[data-market-panel="github"]')!.hidden).toBe(true)
    expect(host.querySelector('[data-market-panel="github"] [data-market-card]')).not.toBeNull()
    expect(search).toHaveBeenCalledTimes(1)

    await click(tab('github'))
    await flush()
    expect(host.querySelector<HTMLElement>('[data-market-panel="github"]')!.hidden).toBe(false)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('moves between the tabs with the arrow, Home and End keys', async () => {
    const { props } = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const local = host.querySelector<HTMLButtonElement>('[data-market-tab="local"]')!
    const github = host.querySelector<HTMLButtonElement>('[data-market-tab="github"]')!
    const token = host.querySelector<HTMLButtonElement>('[data-market-tab="token"]')!
    await pressKey(local, 'ArrowRight')
    expect(github.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(github)
    // The strip runs local → github → token, so ArrowRight wraps around.
    await pressKey(github, 'ArrowRight')
    expect(token.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(token)
    await pressKey(token, 'ArrowRight')
    expect(local.getAttribute('aria-selected')).toBe('true')
    await pressKey(github, 'Home')
    expect(local.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(local)
    await pressKey(local, 'End')
    expect(token.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(token)
    await pressKey(token, 'ArrowLeft')
    expect(github.getAttribute('aria-selected')).toBe('true')
    await pressKey(github, 'ArrowLeft')
    expect(local.getAttribute('aria-selected')).toBe('true')
    // An unrelated key leaves the selection alone.
    await pressKey(local, 'a')
    expect(local.getAttribute('aria-selected')).toBe('true')
  })
})

describe('ManagePluginsTab managed roster', () => {
  it('shows the configured repository, then renders the roster with states', async () => {
    let settle: (value: ManagedPluginList) => void = () => {}
    const list = vi.fn(() => new Promise<ManagedPluginList>(resolve => { settle = resolve }))
    const { props, mocks } = managePageHarness({ list })
    const host = await renderInto(<ManagePluginsTab {...props} />)

    expect(mocks.status).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-market-status="configured"]')).not.toBeNull()
    expect(host.querySelector('[data-market-path]')?.textContent).toBe('/repo')
    expect(host.querySelector('[data-managed-loading]')?.textContent).toContain(zh.loading)

    await act(async () => {
      settle(makeList([
        { key: 'gh-a', repository: 'octocat/demo-plugin', enabled: true },
        { key: 'gh-b', repository: 'acme/helper-plugin', enabled: false },
      ]))
    })
    await flush()

    expect(rows(host)).toHaveLength(2)
    expect(host.textContent).toContain('octocat/demo-plugin')
    expect(host.textContent).toContain('acme/helper-plugin')
    expect(host.textContent).toContain(zh.kindGithub)
    expect(host.textContent).toContain(zh.stateEnabled)
    expect(host.textContent).toContain(zh.stateDisabled)
    expect(host.textContent).toContain(`2 ${zh.countUnit}`)

    const first = rows(host)[0]!
    expect(first.getAttribute('data-plugin-state')).toBe('enabled')
    expect(rows(host)[1]!.getAttribute('data-plugin-state')).toBe('disabled')
    expect(toggles(host)[0]!.getAttribute('aria-checked')).toBe('true')
    expect(toggles(host)[1]!.getAttribute('aria-checked')).toBe('false')
  })

  it('flags an enabled row whose loader fiber failed', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-broken', repository: 'acme/broken', enabled: true, phase: 'failed', lastError: 'boom' },
      { key: 'gh-idle', repository: 'acme/idle', enabled: false },
    ]))
    const { props } = managePageHarness({ list })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const broken = rows(host)[0]!
    expect(broken.getAttribute('data-failed')).toBe('true')
    expect(broken.getAttribute('data-phase')).toBe('failed')
    expect(broken.textContent).toContain(zh.stateFailed)
    expect(rows(host)[1]!.getAttribute('data-failed')).toBeNull()
  })

  it('shows the empty roster state', async () => {
    const { props } = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    expect(host.textContent).toContain(zh.empty)
    expect(host.querySelectorAll('[data-plugin-row]')).toHaveLength(0)
  })

  it('tags every row with its classification and disables the switch of a non-plugin one', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-plugin', repository: 'acme/plugin', enabled: true },
      { key: 'gh-skills', repository: 'acme/skills-pack', classification: 'skills' },
      { key: 'gh-other', repository: 'acme/preset', classification: 'other' },
    ]))
    const setEnabled = vi.fn(async () => { throw new Error('enable must never be called for a non-plugin row') })
    const { props } = managePageHarness({ list, setEnabled })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    expect(rows(host)).toHaveLength(3)

    const tags = Array.from(host.querySelectorAll<HTMLElement>('[data-classification-tag]'))
    expect(tags.map(tag => tag.textContent)).toEqual([
      zh.classificationPlugin,
      zh.classificationSkills,
      zh.classificationOther,
    ])
    expect(tags.map(tag => tag.getAttribute('data-kind'))).toEqual(['plugin', 'skills', 'other'])
    expect(rows(host)[1]!.getAttribute('data-classification')).toBe('skills')
    expect(rows(host)[1]!.getAttribute('data-loadable')).toBe('false')
    expect(rows(host)[0]!.getAttribute('data-loadable')).toBe('true')

    // Only the plugin checkout may be enabled; the skills/other rows say so on
    // the switch itself (label + tooltip) and repeat it as a row note.
    const [pluginSwitch, skillsSwitch, otherSwitch] = Array.from(toggles(host))
    expect(pluginSwitch!.disabled).toBe(false)
    expect(pluginSwitch!.getAttribute('aria-label')).toBe(zh.switchDisable.replace('{name}', 'acme/plugin'))
    const blocked: Array<[HTMLButtonElement, string]> = [
      [skillsSwitch!, 'acme/skills-pack'],
      [otherSwitch!, 'acme/preset'],
    ]
    for (const [toggle, name] of blocked) {
      expect(toggle.disabled).toBe(true)
      expect(toggle.getAttribute('data-not-loadable')).toBe('classification')
      expect(toggle.getAttribute('title')).toBe(zh.switchNotLoadable.replace('{name}', name))
    }
    expect(skillsSwitch!.getAttribute('aria-label'))
      .toBe(zh.switchNotLoadable.replace('{name}', 'acme/skills-pack'))
    expect(otherSwitch!.getAttribute('aria-label'))
      .toBe(zh.switchNotLoadable.replace('{name}', 'acme/preset'))
    const notes = Array.from(host.querySelectorAll('[data-toggle-disabled-note]'))
    expect(notes.map(note => note.textContent)).toEqual([
      zh.switchNotLoadable.replace('{name}', 'acme/skills-pack'),
      zh.switchNotLoadable.replace('{name}', 'acme/preset'),
    ])
    expect(host.querySelectorAll('[data-toggle-disabled-note]')).toHaveLength(2)

    // Clicking a disabled switch is inert: the control layer is never asked.
    await click(skillsSwitch)
    await flush()
    expect(setEnabled).not.toHaveBeenCalled()
    expect(rows(host)[1]!.getAttribute('data-plugin-state')).toBe('disabled')
  })

  it('disables the switch of a plugin-classified row that has no runnable entry', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-unbuilt', repository: 'acme/unbuilt', classification: 'plugin', entry: null },
      { key: 'gh-skills', repository: 'acme/skills-pack', classification: 'skills' },
    ]))
    const setEnabled = vi.fn(async () => { throw new Error('enable must never be called without an entry') })
    const { props } = managePageHarness({ list, setEnabled })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    expect(host.querySelector('[data-classification-tag]')?.textContent).toBe(zh.classificationPlugin)
    const toggle = toggles(host)[0]!
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('data-not-loadable')).toBe('entry')
    // The two gate reasons get their own sentence: a plugin without a runnable
    // entry is not the same user situation as a non-plugin checkout.
    const entryCopy = zh.switchNotLoadableEntry.replace('{name}', 'acme/unbuilt')
    expect(toggle.getAttribute('aria-label')).toBe(entryCopy)
    expect(toggle.getAttribute('title')).toBe(entryCopy)
    expect(host.querySelector('[data-toggle-disabled-note]')?.textContent).toBe(entryCopy)
    expect(entryCopy).not.toBe(zh.switchNotLoadable.replace('{name}', 'acme/unbuilt'))

    // The classification row right below keeps the shared classification copy.
    const skillsToggle = toggles(host)[1]!
    expect(skillsToggle.getAttribute('aria-label'))
      .toBe(zh.switchNotLoadable.replace('{name}', 'acme/skills-pack'))

    await click(toggle)
    await flush()
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('re-files a row through the classification picker and refreshes the roster', async () => {
    let snapshot = makeList([
      { key: 'gh-skills', repository: 'acme/skills-pack', classification: 'skills' },
    ])
    const list = vi.fn(async () => snapshot)
    const setClassification = vi.fn(async (_key: PluginMarketKey) => {
      snapshot = makeList([
        { key: 'gh-skills', repository: 'acme/skills-pack', classification: 'plugin' },
      ])
      return snapshot.entries[0]!.record
    })
    const { props } = managePageHarness({ list, setClassification })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    // The tag is the manual-correction entry of the row.
    expect(host.querySelector('[data-classification-tag]')?.textContent).toBe(zh.classificationSkills)
    await click(host.querySelector('[data-classification-tag]'))
    await flush()

    const dialog = host.querySelector('[data-dialog="classification"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('data-classification-key')).toBe('gh-skills')
    // One radio per tag, with the current one pre-selected.
    const options = Array.from(dialog?.querySelectorAll<HTMLElement>('[data-classification-option]') ?? [])
    expect(options.map(option => option.getAttribute('data-classification-option')))
      .toEqual(['plugin', 'skills', 'other'])
    expect(dialog?.querySelector('[data-classification-option="skills"]')?.getAttribute('data-selected'))
      .toBe('true')
    expect(dialog?.querySelector('[data-classification-option="skills"] input')?.hasAttribute('checked')).toBe(true)

    // Pick another tag and save: the host is asked for exactly that change.
    await click(dialog?.querySelector('[data-classification-option="plugin"] input'))
    await flush()
    await click(dialog?.querySelector('[data-classification-confirm]'))
    await flush()

    expect(setClassification).toHaveBeenCalledWith('gh-skills', 'plugin')
    expect(host.querySelector('[data-dialog="classification"]')).toBeNull()
    // The roster reloaded and the row now carries the corrected tag.
    expect(list).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-classification-tag]')?.textContent).toBe(zh.classificationPlugin)
  })

  it('keeps the correction dialog open with the wire code when the label is refused', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-skills', repository: 'acme/skills-pack', classification: 'skills' },
    ]))
    const setClassification = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'market/bad-request', message: 'nope', details: {} })
    })
    const { props } = managePageHarness({ list, setClassification })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    await click(host.querySelector('[data-classification-tag]'))
    await flush()
    await click(host.querySelector('[data-dialog="classification"] [data-classification-confirm]'))
    await flush()

    const error = host.querySelector('[data-classification-error]')
    expect(error).not.toBeNull()
    expect(error?.getAttribute('data-error-code')).toBe('market/bad-request')
    expect(error?.textContent).toContain('market/bad-request')
    // The dialog stays open so the user can retry or cancel.
    expect(host.querySelector('[data-dialog="classification"]')).not.toBeNull()
  })

  it('filters managed rows and shows the empty-search state', async () => {
    const list = vi.fn(async () => makeList([
      { key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false },
      { key: 'gh-b', repository: 'acme/other-plugin', enabled: false },
    ]))
    const { props } = managePageHarness({ list })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const input = host.querySelector<HTMLInputElement>('[data-manage-filter]')!
    expect(input.placeholder).toBe(zh.filterPlaceholder)
    expect(input.getAttribute('aria-label')).toBe(zh.filterPlaceholder)
    expect(input.getAttribute('aria-describedby')).toBeNull()
    expect(host.querySelector('[data-manage-filter-hint]')).toBeNull()

    await typeInto(input, 'demo')
    expect(rows(host)).toHaveLength(1)
    expect(rows(host)[0]?.getAttribute('data-plugin-key')).toBe('gh-a')

    await typeInto(input, 'zzz')
    expect(rows(host)).toHaveLength(0)
    expect(host.textContent).toContain(zh.emptySearch)

    await typeInto(input, '')
    expect(rows(host)).toHaveLength(2)
  })

  it('converges list failures into the error state and heals on retry', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new MarketCallFailure({
        code: 'market/unreachable',
        message: 'network down',
        details: {},
      }))
      .mockResolvedValueOnce(makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }]))
    const { props } = managePageHarness({ list })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const failure = host.querySelector('[data-list-error]')
    expect(failure).not.toBeNull()
    expect(failure?.getAttribute('data-error-code')).toBe('market/unreachable')
    expect(host.textContent).toContain(zh.error)

    await click(failure?.querySelector('button'))
    await flush()
    expect(host.querySelector('[data-list-error]')).toBeNull()
    expect(rows(host)).toHaveLength(1)
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
    const { props } = managePageHarness({ list, setEnabled })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    await click(toggles(host)[0])
    await flush()

    expect(setEnabled).toHaveBeenCalledWith('gh-a', true)
    expect(list).toHaveBeenCalledTimes(2)
    expect(rows(host)[0]!.getAttribute('data-plugin-state')).toBe('enabled')
    expect(toggles(host)[0]!.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the previous state and surfaces an inline failure when a toggle fails', async () => {
    const list = vi.fn(async () => makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }]))
    const setEnabled = vi.fn(async () => {
      throw new MarketCallFailure({ code: 'market/protected', message: 'protected', details: {} })
    })
    const { props } = managePageHarness({ list, setEnabled })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    await click(toggles(host)[0])
    await flush()

    expect(rows(host)[0]!.getAttribute('data-plugin-state')).toBe('disabled')
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
    const { props } = managePageHarness({ list, setEnabled })
    const host = await renderInto(<ManagePluginsTab {...props} />)
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
    const { props } = managePageHarness({ list })
    const host = await renderInto(<ManagePluginsTab {...props} />)

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
    const { props } = managePageHarness({ list, setEnabled })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    await click(toggles(host)[0])
    const root = roots.pop()!
    await act(async () => { root.unmount() })
    await act(async () => { settleToggle() })
    await flush()
    expect(host.textContent).toBe('')
    expect(list).toHaveBeenCalledTimes(1)
    host.remove()
  })

  it('focuses the remove dialog on open and dismisses it on Escape', async () => {
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
    // Initial focus lands inside the dialog.
    expect(dialog?.contains(document.activeElement)).toBe(true)
    // Escape dismisses the ask step (no removal request is in flight); the row
    // stays untouched for a later retry.
    await pressKey(dialog?.querySelector('[data-remove-cancel]'), 'Escape')
    await flush()
    expect(host.querySelector('[data-dialog="remove"]')).toBeNull()
    expect(rows(host)).toHaveLength(1)
  })
})

describe('ManagePluginsTab access-token tab', () => {
  /** Open the page's third tab (lazily mounted, like the GitHub one). */
  async function openTokenTab(host: HTMLElement): Promise<HTMLElement> {
    await click(host.querySelector('[data-market-tab="token"]'))
    await flush()
    return host.querySelector<HTMLElement>('[data-market-token-panel]')!
  }

  /** The known sources and their dictionary keys (the closed part of the union). */
  const KNOWN_SOURCES = {
    env: 'tokenSourceEnv',
    file: 'tokenSourceFile',
    'project-env': 'tokenSourceProjectEnv',
    'user-env': 'tokenSourceUserEnv',
  } as const

  /** The expected status line of one status seed (zh dictionary templates). */
  function statusLine(
    seed: {
      configured?: boolean
      source?: keyof typeof KNOWN_SOURCES
      ref?: string
      /** Mask the host supplied; omitted = the line carries no mask segment. */
      maskedHint?: string
    },
  ): string {
    const configured = seed.configured ?? false
    const sourceKey = seed.source === undefined ? undefined : KNOWN_SOURCES[seed.source]
    const source = sourceKey === undefined ? zh.tokenSourceOther : zh[sourceKey]
    const line = zh.tokenStatusLine
      .replace('{ref}', seed.ref ?? 'DSH_GITHUB_TOKEN')
      .replace('{source}', source)
      .replace('{state}', configured ? zh.tokenConfigured : zh.tokenUnconfigured)
    if (!configured || seed.maskedHint === undefined) return line
    // The mask rides as a LABEL-FREE trailing segment: just the separator and the
    // host's string, so the line reads "… · 已配置 · ghp_••••••••WXYZ".
    return `${line} · ${seed.maskedHint}`
  }

  it('mounts the panel lazily and reads the token status only once it is selected', async () => {
    const harness = managePageHarness()
    const host = await renderInto(<ManagePluginsTab {...harness.props} />)
    await flush()
    // The override-able spies live on `props`: `harness.mocks` only holds the
    // harness defaults, which an override replaces.
    const tokenStatus = harness.props.tokenStatus
    await flush()
    expect(tokenStatus).not.toHaveBeenCalled()
    expect(host.querySelector('[data-market-token-panel]')).toBeNull()

    const panel = await openTokenTab(host)
    expect(tokenStatus).toHaveBeenCalledTimes(1)
    expect(panel.querySelector('[data-market-panel="token"]')).toBeNull()
    expect(panel.querySelector('[data-token-loading]')).toBeNull()

    // Switching away hides the panel without unmounting it: the status it read
    // survives the round trip (and no second read is issued).
    await click(host.querySelector('[data-market-tab="local"]'))
    await flush()
    await click(host.querySelector('[data-market-tab="token"]'))
    await flush()
    expect(tokenStatus).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-market-token-panel] [data-token-input]')).not.toBeNull()
  })

  it('renders the unconfigured state with a usable input and no clear action', async () => {
    const { props } = managePageHarness({
      tokenStatus: vi.fn(async () => makeTokenStatus({ configured: false, writable: true })),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)

    const status = panel.querySelector<HTMLElement>('[data-token-status]')!
    // The effective reference is rendered even while unconfigured: a deployment
    // that would write GITHUB_TOKEN must not read as "nothing is configured".
    expect(status.textContent).toBe(statusLine({ configured: false }))
    expect(status.getAttribute('data-token-configured')).toBe('false')

    const input = panel.querySelector<HTMLInputElement>('[data-token-input]')!
    expect(input.type).toBe('password')
    expect(input.disabled).toBe(false)
    expect(input.getAttribute('aria-label')).toBe(zh.tokenInputLabel)
    const save = panel.querySelector<HTMLButtonElement>('[data-token-save]')!
    expect(save.disabled).toBe(false)
    expect(save.textContent).toContain(zh.tokenSaveButton)
    // Nothing is stored yet, so a clear has no target.
    expect(panel.querySelector<HTMLButtonElement>('[data-token-clear]')!.disabled).toBe(true)
    // The guidance names the reference a write targets instead of the raw env name.
    expect(panel.querySelector('[data-token-hint]')?.textContent)
      .toBe(zh.tokenSourceHint.replace('{ref}', 'DSH_GITHUB_TOKEN'))
    expect(panel.querySelector('[data-token-hint]')?.getAttribute('data-token-readonly')).toBeNull()
  })

  it('reports a stored token as configured and shows the effective reference name', async () => {
    const tokenStatus = vi.fn(async () => makeTokenStatus({
      configured: true,
      source: 'file',
      writable: true,
      ref: 'GITHUB_TOKEN',
      maskedHint: 'ghp_••••••••WXYZ',
    }))
    const { props } = managePageHarness({ tokenStatus })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)

    const status = panel.querySelector<HTMLElement>('[data-token-status]')!
    // Only the second name resolves here: the line must name THAT reference
    // rather than the preferred head, otherwise a live token reads as missing.
    expect(status.textContent).toBe(statusLine({
      configured: true,
      source: 'file',
      ref: 'GITHUB_TOKEN',
      maskedHint: 'ghp_••••••••WXYZ',
    }))
    expect(status.textContent).toContain('GITHUB_TOKEN')
    // The mask the HOST built rides the line verbatim, as its own label-free
    // segment: the separator and the string, nothing between them.
    expect(panel.querySelector('[data-token-mask]')?.textContent).toBe(' · ghp_••••••••WXYZ')
    expect(status.getAttribute('data-token-configured')).toBe('true')
    expect(panel.querySelector<HTMLInputElement>('[data-token-input]')!.disabled).toBe(false)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-clear]')!.disabled).toBe(false)
    expect(tokenStatus).toHaveBeenCalledTimes(1)
  })

  it('locks the input and both actions when the launch environment supplies the token', async () => {
    const saveToken = vi.fn(async () => makeTokenUpdate({ configured: true, source: 'file' }))
    const clearToken = vi.fn(async () => makeTokenUpdate({ configured: false }))
    const { props } = managePageHarness({
      tokenStatus: vi.fn(async () => makeTokenStatus({
        configured: true,
        source: 'env',
        writable: false,
      })),
      saveToken,
      clearToken,
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)

    expect(panel.querySelector<HTMLInputElement>('[data-token-input]')!.disabled).toBe(true)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-save]')!.disabled).toBe(true)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-clear]')!.disabled).toBe(true)
    const hint = panel.querySelector<HTMLElement>('[data-token-hint]')!
    expect(hint.getAttribute('data-token-readonly')).toBe('true')
    // The way out is environmental: unset the variable in the shell that starts
    // dsh instead of writing a value the launch environment would shadow.
    expect(hint.textContent).toBe(zh.tokenEnvHint.replace('{ref}', 'DSH_GITHUB_TOKEN'))
    expect(panel.querySelector('[data-token-status]')?.textContent)
      .toBe(statusLine({ configured: true, source: 'env' }))

    // Clicking a disabled switch is a no-op: nothing is written.
    await click(panel.querySelector('[data-token-save]'))
    await click(panel.querySelector('[data-token-clear]'))
    expect(saveToken).not.toHaveBeenCalled()
    expect(clearToken).not.toHaveBeenCalled()
  })

  it('saves the typed token, clears the input and re-reads the status from the answer', async () => {
    const tokenStatus = vi.fn(async () => makeTokenStatus({ configured: false, writable: true }))
    const saveToken = vi.fn(async () => makeTokenUpdate({ configured: true, source: 'file', ref: 'DSH_GITHUB_TOKEN' }))
    const { props } = managePageHarness({ tokenStatus, saveToken })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)

    const input = panel.querySelector<HTMLInputElement>('[data-token-input]')!
    await typeInto(input, 'ghp_secret_value')
    await click(panel.querySelector('[data-token-save]'))
    await flush()

    expect(saveToken).toHaveBeenCalledTimes(1)
    // The value travels as typed: the host owns the "never store a blank" rule.
    expect(saveToken).toHaveBeenCalledWith('ghp_secret_value')
    expect(input.value).toBe('')
    expect(panel.querySelector('[data-token-notice]')?.textContent).toBe(zh.tokenSaved)
    expect(panel.querySelector<HTMLElement>('[data-token-status]')!.textContent)
      .toBe(statusLine({ configured: true, source: 'file' }))
    // The answer IS the post-write status: no second read is needed.
    expect(tokenStatus).toHaveBeenCalledTimes(1)
    expect(panel.querySelector<HTMLButtonElement>('[data-token-clear]')!.disabled).toBe(false)
  })

  it('clears the stored token and reports the status the host answered with', async () => {
    const clearToken = vi.fn(async () => makeTokenUpdate({ configured: false, ref: 'DSH_GITHUB_TOKEN' }))
    const { props } = managePageHarness({
      tokenStatus: vi.fn(async () => makeTokenStatus({ configured: true, source: 'file', writable: true })),
      clearToken,
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)

    await click(panel.querySelector('[data-token-clear]'))
    await flush()

    expect(clearToken).toHaveBeenCalledTimes(1)
    expect(panel.querySelector('[data-token-notice]')?.textContent).toBe(zh.tokenCleared)
    const status = panel.querySelector<HTMLElement>('[data-token-status]')!
    expect(status.textContent).toBe(statusLine({ configured: false }))
    expect(status.getAttribute('data-token-configured')).toBe('false')
    expect(panel.querySelector<HTMLButtonElement>('[data-token-clear]')!.disabled).toBe(true)
  })

  it('branches on the stable error codes of a refused write without instanceof checks', async () => {
    const { props } = managePageHarness({
      saveToken: vi.fn(async () => {
        throw new MarketCallFailure({ code: 'github/bad-request', message: 'empty token', details: {} })
      }),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    let panel = await openTokenTab(host)

    await typeInto(panel.querySelector<HTMLInputElement>('[data-token-input]')!, '')
    await click(panel.querySelector('[data-token-save]'))
    await flush()
    let error = panel.querySelector<HTMLElement>('[data-token-error]')!
    expect(error.getAttribute('data-error-code')).toBe('github/bad-request')
    expect(error.textContent).toBe(zh.tokenErrorBadRequest)
    // The refused write changed nothing locally: the status still reads as it did.
    expect(panel.querySelector('[data-token-notice]')).toBeNull()
    expect(panel.querySelector('[data-token-status]')?.getAttribute('data-token-configured')).toBe('false')

    const root = roots.pop()!
    await act(async () => { root.unmount() })
    host.remove()

    // A deployment with no credential seam answers the one stable code for both
    // halves; the panel says so instead of rendering a bare code line.
    const second = managePageHarness({
      tokenStatus: vi.fn(async () => {
        throw new MarketCallFailure({ code: 'github/token-unavailable', message: 'no seam', details: {} })
      }),
    })
    const host2 = await renderInto(<ManagePluginsTab {...second.props} />)
    await flush()
    panel = await openTokenTab(host2)
    const loadError = panel.querySelector<HTMLElement>('[data-token-load-error]')!
    expect(loadError.getAttribute('data-error-code')).toBe('github/token-unavailable')
    expect(loadError.textContent).toContain(zh.tokenLoadFailed)
    expect(loadError.textContent).toContain(zh.tokenErrorUnavailable)
    expect(panel.querySelector('[data-token-input]')).toBeNull()

    // A code this build does not know falls back to the code line (soft branch).
    const third = managePageHarness({
      saveToken: vi.fn(async () => {
        throw new MarketCallFailure({ code: 'repository/io', message: 'write failed', details: {} })
      }),
    })
    const host3 = await renderInto(<ManagePluginsTab {...third.props} />)
    await flush()
    panel = await openTokenTab(host3)
    await typeInto(panel.querySelector<HTMLInputElement>('[data-token-input]')!, 'ghp_x')
    await click(panel.querySelector('[data-token-save]'))
    await flush()
    expect(panel.querySelector('[data-token-error]')?.textContent)
      .toBe(zh.tokenErrorWithCode.replace('{code}', 'repository/io'))
  })

  it('disables the input and actions while a write is in flight and ignores a late answer', async () => {
    let settle: (value: GitHubTokenUpdateResult) => void = () => {}
    const { props } = managePageHarness({
      saveToken: vi.fn(() => new Promise<GitHubTokenUpdateResult>(resolve => { settle = resolve })),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)

    const input = panel.querySelector<HTMLInputElement>('[data-token-input]')!
    await typeInto(input, 'ghp_secret')
    await click(panel.querySelector('[data-token-save]'))

    expect(input.disabled).toBe(true)
    expect(panel.querySelector('[data-token-body]')?.getAttribute('aria-busy')).toBe('true')
    expect(panel.querySelector('[data-token-save]')?.textContent).toContain(zh.tokenSaving)

    // Unmounting while the write is in flight: the late answer must not write
    // into a component that is gone.
    const root = roots.pop()!
    await act(async () => { root.unmount() })
    await act(async () => { settle(makeTokenUpdate({ configured: true, source: 'file' })) })
    await flush()
    expect(host.textContent).toBe('')
    host.remove()
  })
})

describe('ManagePluginsTab token mask on the status line', () => {
  /** Open the page's third tab (lazily mounted, like the GitHub one). */
  async function openTokenTab(host: HTMLElement): Promise<HTMLElement> {
    await click(host.querySelector('[data-market-tab="token"]'))
    await flush()
    return host.querySelector<HTMLElement>('[data-market-token-panel]')!
  }

  it('renders the host-built mask as its own trailing segment of the status line', async () => {
    const maskedHint = 'ghp_••••••••WXYZ'
    const { props } = managePageHarness({
      tokenStatus: vi.fn(async () => makeTokenStatus({
        configured: true,
        source: 'file',
        writable: true,
        maskedHint,
      })),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)

    const status = panel.querySelector<HTMLElement>('[data-token-status]')!
    const mask = status.querySelector<HTMLElement>('[data-token-mask]')!
    // The mask is a SEGMENT, not a sentence: the dictionary copy is untouched and
    // the host's string is rendered verbatim (8 dots and the last four
    // characters exactly as it arrived), with no label of its own.
    expect(status.textContent).toBe(`${zh.tokenStatusLine
      .replace('{ref}', 'DSH_GITHUB_TOKEN')
      .replace('{source}', zh.tokenSourceFile)
      .replace('{state}', zh.tokenConfigured)} · ${maskedHint}`)
    expect(mask.textContent).toBe(` · ${maskedHint}`)
    expect(mask.textContent).toContain(maskedHint)
    // Hard red line: the plaintext value never reaches the DOM at all.
    expect(host.textContent).not.toContain('ghp_1234567890abcdefWXYZ')
  })

  it('renders a short token as the dot run alone and never as its characters', async () => {
    const maskedHint = '••••••••'
    const { props } = managePageHarness({
      tokenStatus: vi.fn(async () => makeTokenStatus({
        configured: true,
        source: 'file',
        writable: true,
        maskedHint,
      })),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)

    const mask = panel.querySelector<HTMLElement>('[data-token-status] [data-token-mask]')!
    expect(mask.textContent).toBe(` · ${maskedHint}`)
    // Nothing of the stored value may appear: a short value contributes no
    // character to its mask.
    expect(host.textContent).not.toContain('ghp_123')
    expect(host.textContent).not.toContain('1234')
  })

  it('omits the mask segment entirely while unconfigured (no dangling separator)', async () => {
    const { props } = managePageHarness({
      tokenStatus: vi.fn(async () => makeTokenStatus({ configured: false, writable: true })),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)

    const status = panel.querySelector<HTMLElement>('[data-token-status]')!
    expect(status.querySelector('[data-token-mask]')).toBeNull()
    const line = status.textContent!
    expect(line).toBe(zh.tokenStatusLine
      .replace('{ref}', 'DSH_GITHUB_TOKEN')
      .replace('{source}', zh.tokenSourceOther)
      .replace('{state}', zh.tokenUnconfigured))
    // No separator, no space, no placeholder left behind by the absent segment.
    expect(line.endsWith(zh.tokenUnconfigured)).toBe(true)
    expect(line.endsWith('·')).toBe(false)
    expect(line.endsWith(' ')).toBe(false)
  })

  it('never renders the segment for a hint the host did not really supply', async () => {
    // A foreign producer sending an empty string rather than omitting the field
    // must not produce a bare separator with nothing after it.
    const { props } = managePageHarness({
      tokenStatus: vi.fn(async () => makeTokenStatus({
        configured: true,
        source: 'file',
        writable: true,
        maskedHint: '',
      })),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)
    expect(panel.querySelector('[data-token-mask]')).toBeNull()
    const line = panel.querySelector<HTMLElement>('[data-token-status]')!.textContent!
    // The unconfigured/label-free line, untouched: no separator, no space.
    expect(line.endsWith(zh.tokenConfigured)).toBe(true)
    expect(line.endsWith('·')).toBe(false)
    expect(line.endsWith(' ')).toBe(false)
  })

  it('shows the mask for the read-only launch environment exactly like the stored layer', async () => {
    const maskedHint = 'ghp_••••••••WXYZ'
    const { props } = managePageHarness({
      tokenStatus: vi.fn(async () => makeTokenStatus({
        configured: true,
        source: 'env',
        writable: false,
        maskedHint,
      })),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)

    // The read-only layer changes which ACTIONS exist, never whether the mask is
    // shown: the user still needs to see which token the launch environment set.
    expect(panel.querySelector<HTMLElement>('[data-token-status] [data-token-mask]')?.textContent)
      .toBe(` · ${maskedHint}`)
    expect(panel.querySelector<HTMLInputElement>('[data-token-input]')!.disabled).toBe(true)
  })

  it('follows the mask of a saved value and drops it again after a clear', async () => {
    const savedMask = 'ghp_••••••••WXYZ'
    const { props } = managePageHarness({
      tokenStatus: vi.fn(async () => makeTokenStatus({ configured: false, writable: true })),
      saveToken: vi.fn(async () => makeTokenUpdate({
        configured: true,
        source: 'file',
        maskedHint: savedMask,
      })),
      clearToken: vi.fn(async () => makeTokenUpdate({ configured: false })),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()
    const panel = await openTokenTab(host)
    expect(panel.querySelector('[data-token-mask]')).toBeNull()

    await typeInto(panel.querySelector<HTMLInputElement>('[data-token-input]')!, 'ghp_1234567890abcdefWXYZ')
    await click(panel.querySelector('[data-token-save]'))
    await flush()
    // The mask comes from the write ANSWER's status, not from a second read and
    // not from anything the component derived itself.
    expect(panel.querySelector<HTMLElement>('[data-token-status] [data-token-mask]')?.textContent)
      .toBe(` · ${savedMask}`)

    await click(panel.querySelector('[data-token-clear]'))
    await flush()
    const status = panel.querySelector<HTMLElement>('[data-token-status]')!
    expect(status.querySelector('[data-token-mask]')).toBeNull()
    expect(status.textContent!.endsWith(zh.tokenUnconfigured)).toBe(true)
  })
})
