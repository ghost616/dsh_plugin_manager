/**
 * dsh-plugin-market browser half: the localized plugin-market settings page
 * (repository status, GitHub search/download, managed roster).
 *
 * Activation contract:
 * - Requires the browser platform services `slots` (SlotRegistry) and
 *   `locale` (LocaleRuntime); the row loads only while both are live.
 * - Registers its dictionaries under one namespace, then contributes one
 *   top-level `settings.section` page (id `market`) behind the settings
 *   shell's declaration. The page owns its own three tabs in-page (local
 *   repository / GitHub / access token), so nothing is contributed to
 *   `settings.plugins.tab` and no second entry point appears under Plugins.
 *   Registration and unload are effects: the dictionaries are bound to this
 *   fiber and the page rides `ctx.slots.inject`, so a settings-shell remount
 *   re-registers the page and an unload removes it.
 * - The channel is never touched at apply time: only closures are installed
 *   and the tab calls the control service lazily through the web channel
 *   (`src/client/channel.ts`), branching on `ok`/`code` at the call site.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only platform merges: ctx.locale, ctx.slots, and the settings slot
// contract (these imports carry zero runtime bytes across the client edge).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// The settings slot contract: `settings.section` and the owner share a section
// receives (the shell's `close` affordance).
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DownloadClassification,
  DownloadCommit,
  DownloadPreparation,
  GitHubSearchPage,
  GitHubTokenUpdateResult,
  GithubRefKind,
  ManagedPluginList,
  MarketStatus,
  PluginInstallReview,
  PluginMarketClassification,
  PluginMarketKey,
  PluginMarketRecord,
  RemoveOutcome,
  RemoveRequest,
  RepositoryDetail,
} from '../types.ts'
import type { MarketTokenStatus } from './channel.ts'
import {
  cancelDownload as channelCancelDownload,
  classifyDownload as channelClassifyDownload,
  clearGitHubToken as channelClearGitHubToken,
  commitDownload as channelCommitDownload,
  confirmRemove as channelConfirmRemove,
  listManaged,
  prepareDownload as channelPrepareDownload,
  previewInstall as channelPreviewInstall,
  repositoryDetail as channelRepositoryDetail,
  requestRemove as channelRequestRemove,
  saveGitHubToken as channelSaveGitHubToken,
  search as channelSearch,
  setClassification as channelSetClassification,
  setEnabled,
  status as channelStatus,
  tokenStatus as channelTokenStatus,
  unwrap,
} from './channel.ts'
import type { MarketManageLocaleKey } from './locales.ts'
import { en, zh } from './locales.ts'
import {
  ManagePluginsTab,
  SEARCH_PAGE_SIZE,
  type ManagePluginsTabInjected,
} from './ManagePluginsTab.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the plugin-market settings page. */
    'settings.plugins.market': MarketManageLocaleKey
  }
}

/** The settings page's owner share (the settings shell supplies `close`). */
export type MarketSectionOwnerProps = SettingsSectionOwnerProps

/** Dictionary namespace owned by the plugin-market UI. */
export const NS = 'settings.plugins.market'

/** Browser platform services required by this contribution. */
export const inject = ['slots', 'locale']

/** Contribute the lazy GitHub-plugin page to the settings navigation. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-market: dictionaries')

  const t = ctx.locale.bind(NS)

  // Lazy channel closures: nothing is read from the wire during apply or
  // registration; only the tab's effects call these and branch on the result.
  const status: ManagePluginsTabInjected['status'] = async (): Promise<MarketStatus> => {
    return unwrap(await channelStatus())
  }
  const list: ManagePluginsTabInjected['list'] = async (): Promise<ManagedPluginList> => {
    return unwrap(await listManaged())
  }
  const setEnabledRecord: ManagePluginsTabInjected['setEnabled'] =
    async (key: PluginMarketKey, enabled: boolean): Promise<PluginMarketRecord> => {
      return unwrap(await setEnabled(key, enabled))
    }
  const setClassificationRecord: ManagePluginsTabInjected['setClassification'] =
    async (key: PluginMarketKey, classification: PluginMarketClassification): Promise<PluginMarketRecord> => {
      return unwrap(await channelSetClassification(key, classification))
    }
  const requestRemoveRecord: ManagePluginsTabInjected['requestRemove'] =
    async (key: PluginMarketKey): Promise<RemoveRequest> => {
      return unwrap(await channelRequestRemove(key))
    }
  const confirmRemoveRecord: ManagePluginsTabInjected['confirmRemove'] =
    async (key: PluginMarketKey, token: string): Promise<RemoveOutcome> => {
      return unwrap(await channelConfirmRemove(key, token))
    }
  const searchRecord: ManagePluginsTabInjected['search'] =
    async (keywords: string, page: number, refresh?: boolean): Promise<GitHubSearchPage> => {
      return unwrap(await channelSearch(keywords, SEARCH_PAGE_SIZE, page, refresh))
    }
  const repositoryDetailRecord: ManagePluginsTabInjected['repositoryDetail'] =
    async (repository: string, refresh?: boolean): Promise<RepositoryDetail> => {
      return unwrap(await channelRepositoryDetail(repository, refresh))
    }
  const previewInstallRecord: ManagePluginsTabInjected['previewInstall'] =
    async (repository: string, version?: string | null, refKind?: GithubRefKind): Promise<PluginInstallReview> => {
      return unwrap(await channelPreviewInstall(repository, refKind, version ?? null))
    }
  const prepareDownloadRecord: ManagePluginsTabInjected['prepareDownload'] =
    async (
      repository: string,
      confirmToken: string,
      version?: string | null,
      refKind?: GithubRefKind,
    ): Promise<DownloadPreparation> => {
      return unwrap(await channelPrepareDownload(repository, confirmToken, refKind, version ?? null))
    }
  const classifyDownloadRecord: ManagePluginsTabInjected['classifyDownload'] =
    async (token: string): Promise<DownloadClassification> => {
      return unwrap(await channelClassifyDownload(token))
    }
  const commitDownloadRecord: ManagePluginsTabInjected['commitDownload'] =
    async (token: string, classification: PluginMarketClassification): Promise<DownloadCommit> => {
      return unwrap(await channelCommitDownload(token, classification))
    }
  const cancelDownloadRecord: ManagePluginsTabInjected['cancelDownload'] =
    async (token: string): Promise<boolean> => {
      return unwrap(await channelCancelDownload(token))
    }
  const tokenStatusRecord: ManagePluginsTabInjected['tokenStatus'] =
    async (): Promise<MarketTokenStatus> => {
      return unwrap(await channelTokenStatus())
    }
  const saveTokenRecord: ManagePluginsTabInjected['saveToken'] =
    async (value: string | null): Promise<GitHubTokenUpdateResult> => {
      return unwrap(await channelSaveGitHubToken(value))
    }
  const clearTokenRecord: ManagePluginsTabInjected['clearToken'] =
    async (): Promise<GitHubTokenUpdateResult> => {
      return unwrap(await channelClearGitHubToken())
    }
  const injected = (): ManagePluginsTabInjected => ({
    status,
    list,
    setEnabled: setEnabledRecord,
    setClassification: setClassificationRecord,
    requestRemove: requestRemoveRecord,
    confirmRemove: confirmRemoveRecord,
    search: searchRecord,
    repositoryDetail: repositoryDetailRecord,
    previewInstall: previewInstallRecord,
    prepareDownload: prepareDownloadRecord,
    classifyDownload: classifyDownloadRecord,
    commitDownload: commitDownloadRecord,
    cancelDownload: cancelDownloadRecord,
    tokenStatus: tokenStatusRecord,
    saveToken: saveTokenRecord,
    clearToken: clearTokenRecord,
  })

  // One top-level settings page; it is the only entry point of this plugin
  // (the Plugins section keeps owning its own tabs, so no tab is registered
  // there).
  //
  // `order: 16` is an ANCHOR, not an arbitrary slot: the shipped deployment
  // lays its settings pages out as General 0 (ui-settings-general) → Models 10
  // (ui-settings-models) → Plugins 15 (ui-settings-plugins) → this page →
  // agent presets 20 (ui-agent-preset). Sitting one step behind Plugins keeps
  // this page inside the plugin-management group (it manages the same roster,
  // through the GitHub side of it) instead of drifting into the later
  // preference pages; retune it only together with those anchors.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'market',
    order: 16,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, ManagePluginsTab))
}

export type { ManagePluginsTabInjected, ManagePluginsTabProps } from './ManagePluginsTab.tsx'
export type { ManageUiFailure } from './ManagePluginsTab.tsx'
export type { MarketManageLocaleKey } from './locales.ts'
