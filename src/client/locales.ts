/**
 * Copy dictionaries of the plugin-market "managed plugins" Settings tab.
 *
 * The zh dictionary is the key source of truth; `en` is constrained to the
 * exact same key set (`satisfies Record<MarketManageLocaleKey, string>`), so a
 * missing or extra English key is a compile error at the registration site.
 */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  /** Plugins-section tab label. */
  tab: '插件管理',
  /** Whole-list loading state. */
  loading: '正在读取已管理插件…',
  /** Whole-list load failure (channel unreachable or a wire failure). */
  error: '暂时无法读取插件。',
  /** Retry the failed list load. */
  retry: '重试',
  /** Filter input label and placeholder. */
  search: '搜索插件',
  /** No managed plugin records exist at all. */
  empty: '暂无已管理插件。',
  /** The filter matched no rows. */
  emptySearch: '没有匹配的插件。',
  /** Item counter unit, e.g. "3 个". */
  countUnit: '个',
  /** Lead label for the record source. */
  sourceLabel: '来源',
  /** GitHub-kind source name. */
  kindGithub: 'GitHub',
  /** Enablement tag shown while a row is enabled. */
  stateEnabled: '已启用',
  /** Enablement tag shown while a row is disabled. */
  stateDisabled: '已停用',
  /** Failure tag shown while an enabled row failed to load. */
  stateFailed: '启动失败',
  /** Phase dot label when no live loader fiber exists. */
  unobserved: '未运行',
  /** Phase dot label while the entry waits for dependencies. */
  phasePending: '等待依赖',
  /** Phase dot label while the entry is loading. */
  phaseLoading: '加载中',
  /** Phase dot label while the entry runs. */
  phaseActive: '运行中',
  /** Phase dot label after the entry failed to load. */
  phaseFailed: '启动失败',
  /** Phase dot label while the entry unloads. */
  phaseUnloading: '卸载中',
  /** Accessible name of the enable switch. */
  switchEnable: '启用「{name}」',
  /** Accessible name of the disable switch. */
  switchDisable: '停用「{name}」',
  /** Accessible busy label while one toggle is in flight. */
  switching: '正在更新「{name}」…',
  /** Inline row failure after a toggle call, with the wire code. */
  toggleFailed: '切换失败（{code}）',
} satisfies Record<string, string>

/** Plugin-market UI locale key union (zh is the key source). */
export type MarketManageLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en: Record<MarketManageLocaleKey, string> = {
  tab: 'Managed plugins',
  loading: 'Reading managed plugins…',
  error: 'Plugins are temporarily unavailable.',
  retry: 'Retry',
  search: 'Search plugins',
  empty: 'No managed plugins yet.',
  emptySearch: 'No matching plugins.',
  countUnit: 'plugins',
  sourceLabel: 'Source',
  kindGithub: 'GitHub',
  stateEnabled: 'Enabled',
  stateDisabled: 'Disabled',
  stateFailed: 'Failed',
  unobserved: 'Not running',
  phasePending: 'Waiting for dependencies',
  phaseLoading: 'Loading',
  phaseActive: 'Running',
  phaseFailed: 'Failed to start',
  phaseUnloading: 'Unloading',
  switchEnable: 'Enable {name}',
  switchDisable: 'Disable {name}',
  switching: 'Updating {name}…',
  toggleFailed: 'Toggle failed ({code})',
}
