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
  /** In-page tab: the GitHub access token (credential seam). */
  tabToken: '访问令牌',
  /** Access-token status: the token comes from the dsh launch environment. */
  tokenSourceEnv: '启动环境',
  /** Access-token status: the token comes from the credential store file. */
  tokenSourceFile: '存储文件',
  /** Access-token status: the invoking project's `.env` file supplies it. */
  tokenSourceProjectEnv: '项目 .env',
  /** Access-token status: the harness home `.env` file supplies it. */
  tokenSourceUserEnv: '用户 .env',
  /** Access-token status: the provider reported a layer this build does not name. */
  tokenSourceOther: '其他来源',
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
  /** Classification tag of a runnable dsh plugin checkout. */
  classificationPlugin: '插件',
  /** Classification tag of a skills/instruction/capability pack. */
  classificationSkills: 'SKILLS',
  /** Classification tag of any other checkout (preset/tooling/docs/unknown). */
  classificationOther: '其他',
  /** Why a non-plugin checkout can never be enabled (switch tooltip/note). */
  switchNotLoadable: '「{name}」不是可加载的插件，无法启用。',
  /** Why a plugin checkout without a runnable entry can never be enabled. */
  switchNotLoadableEntry: '「{name}」没有可加载的入口文件，无法启用。',
  /** Accessible name/tooltip of a row's classification tag (manual correction). */
  classificationFix: '修正「{name}」的分类标签',
  /** Manual-correction dialog title. */
  classificationDialogTitle: '修正分类标签',
  /** Manual-correction dialog explanation (re-files the tag only). */
  classificationDialogBody: '选择「{name}」应被记录的分类：只改写入库标签，不动本地源码与启停状态。',
  /** Manual-correction confirm action. */
  classificationConfirm: '保存标签',
  /** Manual-correction in-flight state. */
  classificationSaving: '正在保存…',
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
  /**
   * Optional wait line appended to the rate-limit copy when the wire failure
   * carries a suggested wait (`details.retryAfterMs`). `{wait}` is a duration
   * phrase built from `rateLimitWaitSeconds`/`rateLimitWaitMinutes`/
   * `rateLimitWaitHours`; a failure without that detail keeps `rateLimited`
   * alone, so no other failure code's copy changes.
   */
  rateLimitWait: '还需等待 {wait}。',
  /** Rate-limit wait unit: seconds. */
  rateLimitWaitSeconds: '{count} 秒',
  /** Rate-limit wait unit: minutes. */
  rateLimitWaitMinutes: '{count} 分钟',
  /** Rate-limit wait unit: hours. */
  rateLimitWaitHours: '{count} 小时',
  /** Network/transport failure. */
  networkError: '网络错误，服务暂时不可达。',
  /** GitHub auth failure. */
  githubAuthError: 'GitHub 请求被拒绝（认证问题）。',
  /** Dedicated copy for a missing/removed GitHub repository. */
  githubNotFound: 'GitHub 仓库不存在或已删除。',
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
  /**
   * Download success message. "Download" only ever means "fetch the sources
   * into the repository": no dependency is installed, and enabling/installing
   * is a later, separate action. (Deliberately avoids the retired "已下载"
   * status wording — nothing is marked as downloaded any more.)
   */
  downloadDone: '下载完成：源码已入库。不会安装依赖，插件默认停用，可在本地仓库列表中处理。',
  /** Download failure heading. */
  downloadFailed: '下载失败。',
  /** Stage row: clone the sources into the staging area. */
  stageClone: '克隆源码',
  /** Stage row: classify the checkout with the model. */
  stageClassify: '分析类型',
  /** Stage row: write the configuration (swap in + record). */
  stageCommit: '写入配置',
  /** Stage state: not started yet. */
  stageWaiting: '等待中',
  /** Stage state: in flight. */
  stageRunning: '进行中',
  /** Stage state: finished. */
  stageDone: '已完成',
  /** Stage state: failed (the row also carries the failure copy). */
  stageFailed: '失败',
  /** Per-phase retry action of the staged download. */
  stageRetry: '重试该阶段',
  /**
   * Verdict notice: the model was not available, so the checkout stays
   * unclassified. Informational — the download continues as `other` and the
   * tag can be corrected by hand from the roster.
   */
  verdictUnclassified: '未判定：模型不可用，可先按「其他」入库，随后在本地仓库列表人工修正分类。',
  /** Verdict notice: the model call failed (same manual-correction path). */
  verdictFailed: '未判定：分析失败，可先按「其他」入库，随后在本地仓库列表人工修正分类。',
  /** Final verdict line of a finished download. */
  verdictFinal: '入库分类：{classification}',
  /**
   * Concrete way out of "no dependencies installed": which command to run, in
   * the checkout directory printed right below this line.
   */
  depsInstallHint: '本次仅下载源码，未安装依赖；如需依赖，请在该插件检出目录执行 pnpm install（目录见下方）。',
  /** Install-dialog loading copy while the preview (incl. smart analysis) runs. */
  previewing: '正在检查该仓库并分析可否安装…',
  /** Confirmation line naming the classification the download will be filed under. */
  classificationNotice: '将标记为：{classification}',
  /**
   * Note of a review whose checkout was classified as a non-plugin (the
   * classification notice above names the tag; this explains the effect).
   */
  classificationNote: '该检出不是可加载的插件：下载后会入库并保持停用，不会注册加载条目。',
  /** Note of a review whose checkout carries no runnable entry. */
  entryMissingNote: '该检出没有可直接加载的入口文件：下载后会入库并保持停用。',
  /**
   * Expected entry path appended to a note line (host `note.entry`), rendered
   * through this template so the raw path is never bare user-visible copy.
   */
  expectedEntryNote: '期望入口：{entry}',
  /** Extra note when the download will need a build step before it can load. */
  buildRequiredNotice: '该仓库缺少可直接加载的入口，下载后需先构建才能启用。',
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
  /*
   * Download-stage failure copy. Every one of these is the PRIMARY line of a
   * failed phase row — the host's own message never becomes visible copy.
   */
  /** The market is not activated (no repository configured). */
  failureMarketIdle: '插件市场未激活：请先配置插件源仓库，再重新下载。',
  /** The download handle is gone (swept after its TTL, or unknown). */
  failureDownloadHandleLost: '下载句柄已失效：请重新发起下载（句柄只在当前进程有效，重启后失效）。',
  /** Generic I/O failure inside the install path. Distinguish from `failureRecordIo`. */
  failureInstallIo: '下载写入失败：请按下方指引处理后重试。',
  /** The records file could not be read or written (I/O). */
  failureRecordIo: '插件记录读写失败：请检查记录文件与所在目录的读写权限，处理后重试。',
  /** The records file is structurally broken, so it cannot be parsed or updated. */
  failureRecordCorrupt: '插件记录文件已损坏（无法解析）：请修复或移除该记录文件后重试。',
  /** The plugin key derived from the ref is not a valid stable key. */
  failureRecordKeyInvalid: '该版本无法生成合法的插件记录标识：请返回详情页改选其他分支或标签后重试。',
  /** The git clone itself failed (network/auth/remote), before any write. */
  failureGitCloneFailed: '拉取源码失败（git clone 未成功）：请检查网络与仓库访问权限后重试。',
  /** The repository slug is not a valid `owner/repo` GitHub slug. */
  failureGithubBadRequest: '仓库地址无效，下载被拒绝：请返回列表重新选择仓库后重试。',
  /** The download confirmation token is not usable for this request. */
  failureConfirmInvalid: '确认信息无效：请重新确认后再下载。',
  /** An orphan checkout already occupies the download target. */
  failureDirExists: '目标检出目录已存在（可能是上次失败留下的孤儿检出）：请按下方路径处理后再重试。',
  /** The target directory is held by a live process. */
  failureDirInUse: '目标检出目录正被占用：请先停用或关闭占用它的插件进程，再重试。',
  /** The trust gate requires an explicit consent first. */
  failureConsentRequired: '该操作需要先在信任门禁中确认授权。',
  /** The records file is invalid, so it cannot be updated. */
  failureRecordInvalid: '插件记录无效，无法写入：请修复记录文件后重试。',
  /** A malformed MARKET request was refused. Distinguish from `failureGithubBadRequest`. */
  failureBadRequest: '请求参数无效，下载被拒绝：请返回详情页重新选择版本后重试。',
  /*
   * `details.reason` guidance (the soft branch). A missing or unknown reason
   * renders none of these and keeps the primary line above.
   */
  /** The staged handle expired: start the download over. */
  failureReasonDownloadExpired: '下载句柄已超时清理：请重新发起下载。',
  /** The handle is unknown to this process (cause unclear). */
  failureReasonDownloadUnknown: '未找到该下载句柄（原因不明）：请重新发起下载；若持续失败，请确认服务是否重启过。',
  /**
   * Pre-swap commit failure.
   *
   * The host's commit removes the previous checkout and then renames the staged
   * one into place, so a failure BEFORE the swap may have already removed the
   * old sources: the copy must NOT claim that nothing changed. It only states
   * that the swap was not completed, and that retrying the stage is supported.
   */
  failureReasonCommitBeforeSwap: '本次未完成换入，目标目录可能处于中间状态：可直接使用「重试该阶段」。',
  /** Post-swap failure with no record: hand cleanup is the only way out. */
  failureReasonRepairNoRecord: '检出已换入但记录未写入：只能先按下方路径手工删除该检出，再重新下载。',
  /** Post-swap failure with a stale record: re-running is idempotent. */
  failureReasonRepairStale: '检出已换入而记录仍是旧的：直接重新下载即可（幂等覆盖，会同步记录）。',
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
  /** Refresh action of the GitHub result list (forces a cache-bypassing read). */
  refreshButton: '刷新',
  /** Refresh action of the open repository detail view. */
  detailRefreshButton: '刷新详情',
  /** Access-token panel state: no token is configured yet. */
  tokenUnconfigured: '未配置',
  /** Access-token panel state: a token is configured and writable. */
  tokenConfigured: '已配置',
  /** Access-token input label and placeholder. */
  tokenInputLabel: 'GitHub 访问令牌',
  /** Access-token save action. */
  tokenSaveButton: '保存',
  /** Access-token clear action. */
  tokenClearButton: '清除',
  /** Access-token panel in-flight state (read or write). */
  tokenSaving: '正在更新令牌…',
  /** Access-token panel load failure. */
  tokenLoadFailed: '暂时无法读取访问令牌状态。',
  /** Status line: which reference is effective, plus its layer and whether set. */
  tokenStatusLine: '生效引用：{ref} · {source} · {state}',
  /**
   * State line of an UNCONFIGURED deployment. Deliberately spells out that a
   * write targets this exact reference, and that setting GITHUB_TOKEN alone is
   * not equivalent — otherwise a deployment resolving only GITHUB_TOKEN would
   * look unconfigured while a request is in fact authenticated.
   */
  tokenSourceHint: '尚未配置令牌：可直接在下方填入，保存后会写入引用 {ref}；仅设置 GITHUB_TOKEN 时该引用不生效。',
  /** Guidance of the read-only launch environment. */
  tokenEnvHint: '令牌由启动环境提供且不可修改：请先在启动 dsh 的 shell 中解除环境变量 {ref} 并重启 dsh，之后才能在此保存或清除。',
  /** Success line after a committed save. */
  tokenSaved: '令牌已保存，后续 GitHub 请求立即生效。',
  /** Success line after a committed clear. */
  tokenCleared: '令牌已清除。',
  /** Failure copy: the stored value cannot be used (empty or malformed). */
  tokenErrorBadRequest: '令牌无效（不能为空）：请填入真实的访问令牌，或使用「清除」。',
  /** Failure copy: no write/clear is possible in this deployment or layer. */
  tokenErrorUnavailable: '当前令牌无法在此保存或清除：它来自只读层，或本部署未挂载凭据服务。',
  /** Generic access-token failure with the wire code. */
  tokenErrorWithCode: '访问令牌操作失败（{code}）。',
} satisfies Record<string, string>

/** Plugin-market UI locale key union (zh is the key source). */
export type MarketManageLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en: Record<MarketManageLocaleKey, string> = {
  tab: 'GitHub plugins',
  tabsLabel: 'Plugin market views',
  tabLocal: 'Local repository',
  tabGithub: 'GitHub',
  tabToken: 'Access token',
  tokenSourceEnv: 'launch environment',
  tokenSourceFile: 'credential store',
  tokenSourceProjectEnv: 'project .env',
  tokenSourceUserEnv: 'user .env',
  tokenSourceOther: 'another source',
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
  classificationPlugin: 'Plugin',
  classificationSkills: 'SKILLS',
  classificationOther: 'Other',
  switchNotLoadable: '{name} is not a loadable plugin and cannot be enabled.',
  switchNotLoadableEntry: '{name} has no loadable entry file and cannot be enabled.',
  classificationFix: 'Correct the classification tag of {name}',
  classificationDialogTitle: 'Correct classification',
  classificationDialogBody: 'Pick the classification {name} should be filed under: only the stored tag changes, sources and enablement stay as they are.',
  classificationConfirm: 'Save tag',
  classificationSaving: 'Saving…',
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
  /**
   * Optional wait line appended to the rate-limit copy when the wire failure
   * carries a suggested wait (`details.retryAfterMs`).
   */
  rateLimitWait: 'About {wait} left to wait.',
  rateLimitWaitSeconds: '{count} seconds',
  rateLimitWaitMinutes: '{count} minutes',
  rateLimitWaitHours: '{count} hours',
  networkError: 'Network error; the service is unreachable.',
  githubAuthError: 'GitHub request rejected (auth problem).',
  githubNotFound: 'The GitHub repository was not found or has been removed.',
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
  prevPage: 'Previous page',
  nextPage: 'Next page',
  pagination: 'Page {current} of {total} · {count} results',
  jumpToLabel: 'Jump to page',
  jumpGo: 'Go',
  repoLinkLabel: 'Open on GitHub',
  starsLabel: '{count} stars',
  updatedLabel: 'Updated {date}',
  downloadButton: 'Download',
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
  /**
   * Download success message. "Download" only ever means "fetch the sources
   * into the repository": no dependency is installed, and enabling/installing
   * is a later, separate action.
   */
  downloadDone: 'Sources downloaded into the repository. No dependencies were installed; the plugin stays disabled until you work with it in the local repository list.',
  downloadFailed: 'Download failed.',
  stageClone: 'Clone sources',
  stageClassify: 'Classify type',
  stageCommit: 'Write configuration',
  stageWaiting: 'Waiting',
  stageRunning: 'Running',
  stageDone: 'Done',
  stageFailed: 'Failed',
  stageRetry: 'Retry this stage',
  verdictUnclassified: 'Not classified: the model is unavailable. It is filed as "other"; correct the tag by hand from the local repository list if needed.',
  verdictFailed: 'Not classified: the analysis failed. It is filed as "other"; correct the tag by hand from the local repository list if needed.',
  verdictFinal: 'Filed as: {classification}',
  depsInstallHint: 'Sources only — no dependencies were installed. Run pnpm install inside this plugin checkout directory (shown below) if you need them.',
  /** Install-dialog loading copy while the preview (incl. smart analysis) runs. */
  previewing: 'Inspecting the repository and analyzing whether it can be installed…',
  /** Confirmation line naming the classification the download will be filed under. */
  classificationNotice: 'Will be tagged as: {classification}',
  /**
   * Note of a review whose checkout was classified as a non-plugin (the
   * classification notice above names the tag; this explains the effect).
   */
  classificationNote: 'This checkout is not a loadable plugin: it is filed as-is and stays disabled, with no loader entry registered.',
  /** Note of a review whose checkout carries no runnable entry. */
  entryMissingNote: 'This checkout carries no ready-to-load entry: it is filed as-is and stays disabled after the download.',
  /**
   * Expected entry path appended to a note line (host `note.entry`), rendered
   * through this template so the raw path is never bare user-visible copy.
   */
  expectedEntryNote: 'Expected entry: {entry}',
  /** Extra note when the download will need a build step before it can load. */
  buildRequiredNotice: 'This repository has no ready-to-load entry; build it after downloading before enabling.',
  analysisNotConfigured: 'Smart analysis is not configured.',
  analysisConfigGuide: 'This repository lacks standard plugin metadata, so smart analysis is required to judge whether it can be installed. Specify the LLM provider and model used for analysis in the plugin settings/config (Config.llm of plugin-market-host), then retry.',
  analysisModelFailed: 'The smart-analysis model call failed; retry, or check the configured model.',
  analysisBadOutput: 'Smart analysis returned an unparsable answer; retry.',
  confirmExpired: 'The confirmation expired; please confirm again.',
  confirmRequired: 'Confirmation is required.',
  protectedEntry: 'This entry is protected and cannot be changed.',
  failureMarketIdle: 'The plugin market is not active: configure a plugin source repository, then start the download again.',
  failureDownloadHandleLost: 'The download handle is no longer usable: start the download again (handles live only in the current process and never survive a restart).',
  failureInstallIo: 'Writing the download failed: follow the guidance below and retry.',
  failureRecordIo: 'Reading or writing the plugin records file failed: check the permissions of the records file and its directory, then retry.',
  failureRecordCorrupt: 'The plugin records file is corrupt (it could not be parsed): repair or remove that records file, then retry.',
  failureRecordKeyInvalid: 'No valid plugin record key can be derived from this version: go back to the detail view and pick another branch or tag, then retry.',
  failureGitCloneFailed: 'Fetching the sources failed (git clone did not succeed): check the network and your access to the repository, then retry.',
  failureGithubBadRequest: 'The repository address is invalid, so the download was refused: go back to the list and pick the repository again.',
  failureConfirmInvalid: 'The download confirmation is not usable: confirm again before downloading.',
  failureDirExists: 'The target checkout directory already exists (likely an orphan from an earlier failure): handle it as shown below, then retry.',
  failureDirInUse: 'The target checkout directory is in use: stop or close the plugin process holding it, then retry.',
  failureConsentRequired: 'This action needs an explicit confirmation in the trust gate first.',
  failureRecordInvalid: 'The plugin records file is invalid, so it cannot be updated: repair it and retry.',
  failureBadRequest: 'The request was rejected as malformed: go back to the detail view, pick the ref again and retry.',
  failureReasonDownloadExpired: 'The staged handle was cleaned up after its time limit: start the download again.',
  failureReasonDownloadUnknown: 'This download handle is unknown to the process (cause unclear): start the download again; if it keeps failing, check whether the service restarted.',
  failureReasonCommitBeforeSwap: 'This swap was not completed and the target directory may be in an intermediate state: use "Retry this stage".',
  failureReasonRepairNoRecord: 'The checkout was swapped in but no record was written: remove that checkout by hand (path below) before downloading again.',
  failureReasonRepairStale: 'The checkout was swapped in while the record still describes the old one: just run the download again (idempotent overwrite that re-syncs the record).',
  failedWithCode: 'Operation failed ({code}).',
  closeButton: 'Close',
  doneButton: 'Done',
  cancelButton: 'Cancel',
  continueButton: 'Continue',
  removeDialogTitle: 'Remove plugin',
  removeStep1: 'Removes {name} sources and record from the local repository and stops its running entry.',
  removeStep2: 'Remove again? This cannot be undone.',
  removing: 'Removing…',
  refreshButton: 'Refresh',
  detailRefreshButton: 'Refresh details',
  tokenUnconfigured: 'Not configured',
  tokenConfigured: 'Configured',
  tokenInputLabel: 'GitHub access token',
  tokenSaveButton: 'Save',
  tokenClearButton: 'Clear',
  tokenSaving: 'Updating the token…',
  tokenLoadFailed: 'The access-token status is temporarily unavailable.',
  tokenStatusLine: 'Effective reference: {ref} · {source} · {state}',
  tokenSourceHint: 'No token is configured yet: enter one below and it is written to {ref}. Setting only GITHUB_TOKEN does not make that reference effective.',
  tokenEnvHint: 'The token comes from the launch environment and cannot be modified: first unset {ref} in the shell that starts dsh and restart dsh, then you can save or clear a token here.',
  tokenSaved: 'Token saved; the next GitHub request uses it.',
  tokenCleared: 'Token cleared.',
  tokenErrorBadRequest: 'The token is not usable (it must not be empty): enter a real access token, or use Clear.',
  tokenErrorUnavailable: 'This token cannot be saved or cleared here: it comes from a read-only layer, or this deployment mounts no credential service.',
  tokenErrorWithCode: 'The access-token operation failed ({code}).',
}
