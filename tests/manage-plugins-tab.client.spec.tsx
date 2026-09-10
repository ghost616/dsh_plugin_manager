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
import type { ManagedPluginList, PluginMarketKey, PluginMarketRecord } from '../src/types.ts'
import { zh } from '../src/client/locales.ts'
import { MarketCallFailure } from '../src/client/channel.ts'
import { ManagePluginsTab } from '../src/client/ManagePluginsTab.tsx'
import {
  makeList,
  makeSearchPage,
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
  it('renders the two localized tabs over the panels, landing on the local repository', async () => {
    const { props } = managePageHarness({
      list: vi.fn(async () => makeList([{ key: 'gh-a', repository: 'octocat/demo-plugin', enabled: false }])),
    })
    const host = await renderInto(<ManagePluginsTab {...props} />)
    await flush()

    const tablist = host.querySelector('[role="tablist"]')
    expect(tablist?.getAttribute('aria-label')).toBe(zh.tabsLabel)
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-market-tab]'))
    expect(tabs.map(tab => tab.getAttribute('data-market-tab'))).toEqual(['local', 'github'])
    expect(tabs.map(tab => tab.textContent)).toEqual([zh.tabLocal, zh.tabGithub])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false')
    // Only the selected tab is in the tab order (arrow keys move between them).
    expect(tabs[0]!.tabIndex).toBe(0)
    expect(tabs[1]!.tabIndex).toBe(-1)

    const panels = Array.from(host.querySelectorAll<HTMLElement>('[data-market-panel]'))
    expect(panels.map(panel => panel.getAttribute('data-market-panel'))).toEqual(['local', 'github'])
    expect(panels[0]!.hidden).toBe(false)
    expect(panels[1]!.hidden).toBe(true)
    expect(panels[0]!.getAttribute('aria-labelledby')).toBe(tabs[0]!.id)
    // The inactive panel is a REPLACEMENT, not a stacked sibling: it is taken
    // out of the layout outright rather than left as an invisible block below
    // the active one. The rule is pinned inline, so no host stylesheet can
    // re-introduce a display value for the hidden panel.
    expect(panels[1]!.style.display).toBe('none')
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
    expect(search).toHaveBeenCalledWith('', 1)
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
    await pressKey(local, 'ArrowRight')
    expect(github.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(github)
    await pressKey(github, 'Home')
    expect(local.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(local)
    await pressKey(local, 'End')
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
