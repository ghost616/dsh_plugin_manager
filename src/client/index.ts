/**
 * dsh-plugin-market browser half: the localized plugin-market settings page
 * (M1: repository status, GitHub search/install, managed roster).
 *
 * Activation contract:
 * - Requires the browser platform services `slots` (SlotRegistry) and
 *   `locale` (LocaleRuntime); the row loads only while both are live.
 * - Registers its dictionaries under one namespace, then contributes one
 *   `settings.plugins.tab` list entry (id `market`) behind the slot's
 *   declaration. Registration and unload are effects: the dictionaries are
 *   bound to this fiber and the tab rides `ctx.slots.inject`, so a Plugins
 *   section remount re-registers the tab and an unload removes it.
 * - The channel is never touched at apply time: only closures are installed
 *   and the tab calls the control service lazily through the web channel
 *   (`src/client/channel.ts`), branching on `ok`/`code` at the call site.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only platform merges: ctx.locale, ctx.slots, and the settings slot
// contract (these imports carry zero runtime bytes across the client edge).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GitHubSearchPage,
  ManagedPluginList,
  MarketStatus,
  PluginInstallOutcome,
  PluginInstallReview,
  PluginMarketKey,
  PluginMarketRecord,
  RemoveOutcome,
  RemoveRequest,
  RepositoryDetail,
} from '../types.ts'
import {
  confirmRemove as channelConfirmRemove,
  install as channelInstall,
  listManaged,
  previewInstall as channelPreviewInstall,
  repositoryDetail as channelRepositoryDetail,
  requestRemove as channelRequestRemove,
  search as channelSearch,
  setEnabled,
  status as channelStatus,
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
    /** Copy of the plugin-market managed-plugins tab. */
    'settings.plugins.market': MarketManageLocaleKey
  }
}

/** Dictionary namespace owned by the plugin-market UI. */
export const NS = 'settings.plugins.market'

/** Browser platform services required by this contribution. */
export const inject = ['slots', 'locale']

/** Contribute the lazy managed-plugins tab to the Plugins settings section. */
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
  const requestRemoveRecord: ManagePluginsTabInjected['requestRemove'] =
    async (key: PluginMarketKey): Promise<RemoveRequest> => {
      return unwrap(await channelRequestRemove(key))
    }
  const confirmRemoveRecord: ManagePluginsTabInjected['confirmRemove'] =
    async (key: PluginMarketKey, token: string): Promise<RemoveOutcome> => {
      return unwrap(await channelConfirmRemove(key, token))
    }
  const searchRecord: ManagePluginsTabInjected['search'] =
    async (keywords: string, page: number): Promise<GitHubSearchPage> => {
      return unwrap(await channelSearch(keywords, SEARCH_PAGE_SIZE, page))
    }
  const repositoryDetailRecord: ManagePluginsTabInjected['repositoryDetail'] =
    async (repository: string): Promise<RepositoryDetail> => {
      return unwrap(await channelRepositoryDetail(repository))
    }
  const previewInstallRecord: ManagePluginsTabInjected['previewInstall'] =
    async (repository: string, version?: string | null): Promise<PluginInstallReview> => {
      return unwrap(await channelPreviewInstall(repository, version ?? null))
    }
  const installRecord: ManagePluginsTabInjected['install'] =
    async (repository: string, confirmToken: string, version?: string | null): Promise<PluginInstallOutcome> => {
      return unwrap(await channelInstall(repository, confirmToken, version ?? null))
    }
  const injected = (): ManagePluginsTabInjected => ({
    status,
    list,
    setEnabled: setEnabledRecord,
    requestRemove: requestRemoveRecord,
    confirmRemove: confirmRemoveRecord,
    search: searchRecord,
    repositoryDetail: repositoryDetailRecord,
    previewInstall: previewInstallRecord,
    install: installRecord,
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'market',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, ManagePluginsTab))
}

export type { ManagePluginsTabInjected, ManagePluginsTabProps } from './ManagePluginsTab.tsx'
export type { ManageUiFailure } from './ManagePluginsTab.tsx'
export type { MarketManageLocaleKey } from './locales.ts'
