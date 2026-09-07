/**
 * dsh-plugin-market browser half: the localized "managed plugins" Settings
 * tab (M0 of the plugin-market UI).
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
  ManagedPluginList,
  PluginMarketKey,
  PluginMarketRecord,
} from '../types.ts'
import { listManaged, setEnabled, unwrap } from './channel.ts'
import type { MarketManageLocaleKey } from './locales.ts'
import { en, zh } from './locales.ts'
import { ManagePluginsTab, type ManagePluginsTabInjected } from './ManagePluginsTab.tsx'

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
  const list: ManagePluginsTabInjected['list'] = async (): Promise<ManagedPluginList> => {
    return unwrap(await listManaged())
  }
  const setEnabledRecord: ManagePluginsTabInjected['setEnabled'] =
    async (key: PluginMarketKey, enabled: boolean): Promise<PluginMarketRecord> => {
      return unwrap(await setEnabled(key, enabled))
    }
  const injected = (): ManagePluginsTabInjected => ({ list, setEnabled: setEnabledRecord })

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
