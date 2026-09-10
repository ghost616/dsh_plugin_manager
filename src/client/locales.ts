/**
 * Copy dictionaries of the plugin-market settings page (managed list +
 * GitHub search/install M1 surface).
 *
 * The zh dictionary is the key source of truth; `en` is constrained to the
 * exact same key set (`satisfies Record<MarketManageLocaleKey, string>`), so a
 * missing or extra English key is a compile error at the registration site.
 */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  /** Settings-navigation label of the whole GitHub-plugin page. */
  tab: 'GitHub 插件',
  /** Accessible name of the page's own tab strip. */
  tabsLabel: '插件市场视图',
  /** In-page tab: the local plugin source repository. */
  tabLocal: '本地仓库',
  /** In-page tab: GitHub search/download. */
  tabGithub: 'GitHub',
  /** Whole-page/list loading state. */
  loading: '正在读取已管理插件…',
  /** Whole-list load failure (channel unreachable or a wire failure). */
  error: '暂时无法读取插件。',
  /** Retry a failed load. */
  retry: '重试',
  /** Re-run the preview after an install failure (mints a fresh token). */
  repreviewButton: '重新预览',
  /** Managed-list local filter placeholder (explicit local semantics). */
  filterPlaceholder: '筛选已管理插件',
  /** No managed plugin records exist at all. */
  empty: '暂无已管理插件。',
  /** The managed-list filter matched no rows. */
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
  /** Repository header label when the market repository is configured. */
  repoLabel: '当前插件源仓库',
  /** Idle header title when no repository path is configured. */
  idleTitle: '插件市场尚未激活',
  /** Idle guidance: how to configure the repository (no write-back UI). */
  idleBody: '在 dsh profile 的 cordis.patch.yml 中为 plugin-market-host 行配置 Config.repositoryPath，指向本地第三方插件源仓库目录；重启 dsh 后生效。',
  /** GitHub search input label and placeholder. */
  githubSearch: '搜索 GitHub 上的 dsh 插件',
  /** GitHub search submit button. */
  searchButton: '搜索',
  /** Search zone idle hint. */
  searchIdle: '输入关键词搜索 GitHub 上的 dsh 插件，找到后可下载到本地插件源仓库。',
  /** Search in-flight state. */
  searching: '正在搜索…',
  /** Search completed with zero hits. */
  searchEmpty: '没有找到匹配的插件。',
  /** Generic search failure. */
  searchFailed: '搜索失败。',
  /** GitHub rate-limit failure. */
  rateLimited: 'GitHub 限流，请稍后再试。',
  /** Network/transport failure. */
  networkError: '网络错误，服务暂时不可达。',
  /** GitHub auth failure. */
  githubAuthError: 'GitHub 请求被拒绝（认证问题）。',
  /** Dedicated copy for a missing/removed GitHub repository. */
  githubNotFound: 'GitHub 仓库不存在或已删除。',
  /** Search results heading. */
  searchResults: '搜索结果',
  /** Detail-view title inside the GitHub tab. */
  detailTitle: '仓库详情',
  /** Back-to-results action of the detail view. */
  detailBack: '返回',
  /** Detail-view in-flight state (metadata + branches/tags + README). */
  detailLoading: '正在加载仓库详情…',
  /** Detail-view load failure. */
  detailError: '无法读取仓库详情。',
  /** Detail-view empty state (no installable branch or tag). */
  detailEmpty: '该仓库没有可安装的分支或标签。',
  /** Label of the merged branch/tag dropdown in the detail view. */
  refSelectLabel: '选择要安装的分支或标签',
  /** Placeholder of the detail-view ref dropdown (nothing selected). */
  refSelectPlaceholder: '请选择…',
  /** Search-result row action opening the repository detail view. */
  rowDetails: '详情',
  /** Branch-name group heading of the detail view. */
  branchesTitle: '分支',
  /** Hint label of the repository default branch inside the branch group. */
  defaultBranchLabel: '默认分支',
  /** Tag-name group heading of the detail view. */
  tagsTitle: '标签',
  /** README section heading of the detail view. */
  readmeHeading: 'README',
  /** Placeholder when the repository has no README. */
  noReadme: '该仓库没有 README。',
  /** Badge of an already-downloaded search result row (its record exists). */
  installedBadge: '已下载',
  /** Previous search page. */
  prevPage: '上一页',
  /** Next search page. */
  nextPage: '下一页',
  /** Pagination status line. */
  pagination: '第 {current}/{total} 页 · 共 {count} 个结果',
  /** Page-jump input accessible label. */
  jumpToLabel: '跳转页码',
  /** Page-jump go action. */
  jumpGo: '跳转',
  /** External repository link label on a result card. */
  repoLinkLabel: '在 GitHub 打开',
  /** Stargazer count of a search result. */
  starsLabel: '{count} 星',
  /** Last-update line of a search result. */
  updatedLabel: '更新于 {date}',
  /** Download action of an unmanaged result. */
  downloadButton: '下载',
  /** Update action of an already-managed result. */
  updateButton: '更新',
  /** Managed list section heading. */
  managedHeading: '已管理插件',
  /** Row action opening the two-step removal flow. */
  removeButton: '删除',
  /** Download confirmation dialog title. */
  downloadDialogTitle: '下载插件',
  /** Declared-dependency section title. */
  depsTitle: '声明依赖',
  /** dependencies list label. */
  depsLabel: 'dependencies',
  /** peerDependencies list label. */
  peerDepsLabel: 'peerDependencies',
  /** Empty dependency list placeholder. */
  depsEmpty: '无',
  /** Overwrite notice shown when the reviewed plugin is already managed. */
  overwriteNotice: '该插件已管理，下载将覆盖其本地源码目录；启停记录保留。',
  /** Degraded-preview notice (manifest unreadable but download possible). */
  degradedNotice: '依赖清单不可读（{code}），仍可继续下载。',
  /** Preview (manifest review) failure. */
  previewFailed: '无法读取该仓库的插件清单。',
  /** Download in-flight state. */
  downloading: '正在下载…',
  /** Download success message. */
  downloadDone: '下载完成。插件默认停用，可在已管理列表中启用。',
  /** Download failure heading. */
  downloadFailed: '下载失败。',
  /** Install-dialog loading copy while the preview (incl. smart analysis) runs. */
  previewing: '正在检查该仓库并分析可否安装…',
  /** Analysis refusal of a plugin-shaped checkout that needs a build first. */
  analysisKindBuild: '该仓库看似 dsh 插件，但缺少可直接加载的入口，需先构建再安装。',
  /** Analysis refusal: the checkout is a skills/instruction pack. */
  analysisKindSkills: '该仓库是技能/指令包（skills pack），不是可安装的 dsh 插件。',
  /** Analysis refusal: the checkout is a configuration preset. */
  analysisKindPreset: '该仓库是配置预设（preset），不是可安装的 dsh 插件。',
  /** Analysis refusal: the checkout is a development tool or CLI. */
  analysisKindTooling: '该仓库是开发工具或命令行程序，不是可安装的 dsh 插件。',
  /** Analysis refusal: the checkout could not be recognized as a plugin. */
  analysisKindOther: '该仓库未能被识别为可安装的 dsh 插件。',
  /** Preview failure when no LLM endpoint is configured for smart analysis. */
  analysisNotConfigured: '智能分析未配置。',
  /** Guidance shown with analysisNotConfigured (where to set provider/model). */
  analysisConfigGuide: '该仓库的常规插件信息不足，需借助智能分析判断可否安装；请在插件设置/配置中为智能安装分析指定模型 provider 与 model（plugin-market-host 的 Config.llm），配置后重试。',
  /** Preview failure when the analysis model call itself failed. */
  analysisModelFailed: '智能分析调用失败，请重试；若持续失败请检查所配置的模型。',
  /** Preview failure when the analysis model returned unparsable output. */
  analysisBadOutput: '智能分析返回了无法解析的结果，请重试。',
  /** Install confirmation expired (re-preview required). */
  confirmExpired: '确认已过期，请重新确认。',
  /** Confirmation missing. */
  confirmRequired: '缺少确认信息。',
  /** Protected-entry refusal. */
  protectedEntry: '该条目受保护，无法操作。',
  /** Generic failure with the wire code. */
  failedWithCode: '操作失败（{code}）。',
  /** Dismiss/close dialog action. */
  closeButton: '关闭',
  /** Success/done dismiss action. */
  doneButton: '完成',
  /** Generic cancel action. */
  cancelButton: '取消',
  /** First-step removal continuation. */
  continueButton: '继续',
  /** Removal dialog title. */
  removeDialogTitle: '删除插件',
  /** Removal step-1 explanation. */
  removeStep1: '将从本地插件源仓库移除「{name}」的源码、记录，并立即停用其运行条目。',
  /** Removal step-2 double confirmation. */
  removeStep2: '再次确认删除？此操作不可撤销。',
  /** Removal in-flight state. */
  removing: '正在删除…',
} satisfies Record<string, string>

/** Plugin-market UI locale key union (zh is the key source). */
export type MarketManageLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en: Record<MarketManageLocaleKey, string> = {
  tab: 'GitHub plugins',
  tabsLabel: 'Plugin market views',
  tabLocal: 'Local repository',
  tabGithub: 'GitHub',
  loading: 'Reading managed plugins…',
  error: 'Plugins are temporarily unavailable.',
  retry: 'Retry',
  repreviewButton: 'Re-preview',
  filterPlaceholder: 'Filter managed plugins',
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
  repoLabel: 'Plugin source repository',
  idleTitle: 'The plugin market is not active',
  idleBody: 'Add Config.repositoryPath to the plugin-market-host row in the dsh profile cordis.patch.yml, pointing at a local third-party plugin source repository, then restart dsh.',
  githubSearch: 'Search GitHub for dsh plugins',
  searchButton: 'Search',
  searchIdle: 'Type a keyword to search dsh plugins on GitHub, then download one into the local plugin source repository.',
  searching: 'Searching…',
  searchEmpty: 'No matching plugins found.',
  searchFailed: 'Search failed.',
  rateLimited: 'GitHub rate limit reached; try again later.',
  networkError: 'Network error; the service is unreachable.',
  githubAuthError: 'GitHub request rejected (auth problem).',
  githubNotFound: 'The GitHub repository was not found or has been removed.',
  searchResults: 'Search results',
  detailTitle: 'Repository details',
  detailBack: 'Back',
  detailLoading: 'Loading repository details…',
  detailError: 'Could not load repository details.',
  detailEmpty: 'This repository has no installable branches or tags.',
  refSelectLabel: 'Select a branch or tag to install',
  refSelectPlaceholder: 'Select…',
  rowDetails: 'Details',
  branchesTitle: 'Branches',
  defaultBranchLabel: 'default branch',
  tagsTitle: 'Tags',
  readmeHeading: 'README',
  noReadme: 'This repository has no README.',
  installedBadge: 'Downloaded',
  prevPage: 'Previous page',
  nextPage: 'Next page',
  pagination: 'Page {current} of {total} · {count} results',
  jumpToLabel: 'Jump to page',
  jumpGo: 'Go',
  repoLinkLabel: 'Open on GitHub',
  starsLabel: '{count} stars',
  updatedLabel: 'Updated {date}',
  downloadButton: 'Download',
  updateButton: 'Update',
  managedHeading: 'Managed plugins',
  removeButton: 'Remove',
  downloadDialogTitle: 'Download plugin',
  depsTitle: 'Declared dependencies',
  depsLabel: 'dependencies',
  peerDepsLabel: 'peerDependencies',
  depsEmpty: 'None',
  overwriteNotice: 'This plugin is already managed; downloading overwrites its local sources and keeps its enablement.',
  degradedNotice: 'Dependency list unreadable ({code}); you can still download.',
  previewFailed: 'Could not read the plugin manifest.',
  downloading: 'Downloading…',
  downloadDone: 'Downloaded. The plugin is disabled by default; enable it from the managed list.',
  downloadFailed: 'Download failed.',
  previewing: 'Inspecting the repository and analyzing whether it can be installed…',
  analysisKindBuild: 'This repository looks like a dsh plugin, but has no ready-to-load entry; build it before installing.',
  analysisKindSkills: 'This repository is a skills/instructions pack, not an installable dsh plugin.',
  analysisKindPreset: 'This repository is a configuration preset, not an installable dsh plugin.',
  analysisKindTooling: 'This repository is a development tool or CLI, not an installable dsh plugin.',
  analysisKindOther: 'This repository was not recognized as an installable dsh plugin.',
  analysisNotConfigured: 'Smart analysis is not configured.',
  analysisConfigGuide: 'This repository lacks standard plugin metadata, so smart analysis is required to judge whether it can be installed. Specify the LLM provider and model used for analysis in the plugin settings/config (Config.llm of plugin-market-host), then retry.',
  analysisModelFailed: 'The smart-analysis model call failed; retry, or check the configured model.',
  analysisBadOutput: 'Smart analysis returned an unparsable answer; retry.',
  confirmExpired: 'The confirmation expired; please confirm again.',
  confirmRequired: 'Confirmation is required.',
  protectedEntry: 'This entry is protected and cannot be changed.',
  failedWithCode: 'Operation failed ({code}).',
  closeButton: 'Close',
  doneButton: 'Done',
  cancelButton: 'Cancel',
  continueButton: 'Continue',
  removeDialogTitle: 'Remove plugin',
  removeStep1: 'Removes {name} sources and record from the local repository and stops its running entry.',
  removeStep2: 'Remove again? This cannot be undone.',
  removing: 'Removing…',
}
