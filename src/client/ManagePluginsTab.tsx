/** Managed-plugins Settings tab: read-only M0 of the plugin-market surface. */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ManagedPluginList,
  ManagedPluginPhase,
  ManagedPluginView,
  PluginMarketKey,
  PluginMarketRecord,
} from '../types.ts'
import type { MarketManageLocaleKey } from './locales.ts'
import css from './ManagePluginsTab.module.css'

/** Registration-side channel face (lazy closures, wired by apply()). */
export interface ManagePluginsTabInjected {
  /** Read the record × loader projection of the managed plugins. */
  list: () => Promise<ManagedPluginList>
  /** Persist and apply one record's enablement through the control channel. */
  setEnabled: (key: PluginMarketKey, enabled: boolean) => Promise<PluginMarketRecord>
}

/** Full component props assembled by the Settings slot renderer. */
export type ManagePluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins.market'>
  & InjectFace<ManagePluginsTabInjected>

type Translate = ManagePluginsTabProps['t']

/** One normalized UI failure (code always present; no instanceof branching). */
export interface ManageUiFailure {
  readonly code: string
  readonly message: string
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly failure: ManageUiFailure }
  | { readonly status: 'ready'; readonly snapshot: ManagedPluginList }

const PHASE_KEYS = {
  pending: 'phasePending',
  loading: 'phaseLoading',
  active: 'phaseActive',
  failed: 'phaseFailed',
  unloading: 'phaseUnloading',
} satisfies Record<Exclude<ManagedPluginPhase, null>, MarketManageLocaleKey>

/** Localized accessible label of one live loader phase. */
function phaseLabel(phase: ManagedPluginPhase, t: Translate): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Row failure: an enabled record whose loader fiber failed this session. */
function rowFailed(view: ManagedPluginView): boolean {
  return view.record.enabled
    && (view.runtime.phase === 'failed' || view.runtime.lastError !== null)
}

/** Display name: the GitHub `owner/repo` slug when the source is GitHub. */
function displayName(view: ManagedPluginView): string {
  const source = view.record.source
  return source.kind === 'github' ? source.repository : view.key
}

/** Whether one row matches the local filter query. */
function matches(view: ManagedPluginView, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [displayName(view), view.key].some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** Normalize any thrown value into the stable UI failure shape. */
function toUiFailure(error: unknown): ManageUiFailure {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown }
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return { code: candidate.code, message: candidate.message }
    }
  }
  return {
    code: 'market/unreachable',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** Inline enable/disable switch of one managed plugin row. */
function EnableSwitch({ view, busy, failure, t, onToggle }: {
  readonly view: ManagedPluginView
  readonly busy: boolean
  readonly failure: ManageUiFailure | undefined
  readonly t: Translate
  readonly onToggle: (view: ManagedPluginView) => void
}): ReactNode {
  const name = displayName(view)
  const switching = busy ? t('switching', { name }) : ''
  const actionLabel = view.record.enabled ? t('switchDisable', { name }) : t('switchEnable', { name })
  return (
    <>
      <button
        type="button"
        role="switch"
        className={css.switch}
        aria-checked={view.record.enabled}
        aria-label={busy ? switching : actionLabel}
        aria-busy={busy}
        data-plugin-toggle
        data-busy={busy ? 'true' : undefined}
        disabled={busy}
        onClick={() => { onToggle(view) }}
      />
      {failure === undefined ? null : (
        <p
          className={css.rowFailure}
          role="alert"
          data-toggle-error
          data-error-code={failure.code}
          title={failure.message}
        >
          {t('toggleFailed', { code: failure.code })}
        </p>
      )}
    </>
  )
}

/** Render the read-only managed-plugin roster with an inline enable switch. */
export function ManagePluginsTab({ list, setEnabled, t }: ManagePluginsTabProps): ReactNode {
  const mounted = useRef(true)
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [rowFailures, setRowFailures] = useState<ReadonlyMap<string, ManageUiFailure>>(() => new Map())

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let current = true
    void Promise.resolve()
      .then(() => list())
      .then(
        (snapshot) => {
          if (!current) return
          setState({ status: 'ready', snapshot })
        },
        (error: unknown) => {
          if (!current) return
          setState({ status: 'error', failure: toUiFailure(error) })
        },
      )
    return () => { current = false }
  }, [list, request])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const toggle = (view: ManagedPluginView): void => {
    if (busyKeys.has(view.key)) return
    const next = !view.record.enabled
    setBusyKeys(previous => new Set(previous).add(view.key))
    setRowFailures(previous => {
      const nextMap = new Map(previous)
      nextMap.delete(view.key)
      return nextMap
    })
    void (async () => {
      try {
        const record = await setEnabled(view.key, next)
        if (!mounted.current) return
        // Resync the loader projection; a failed resync keeps the returned record.
        try {
          const snapshot = await list()
          if (!mounted.current) return
          setState({ status: 'ready', snapshot })
        } catch {
          if (!mounted.current) return
          setState(current => current.status === 'ready'
            ? {
              status: 'ready',
              snapshot: {
                entries: current.snapshot.entries.map(entry =>
                  entry.key === view.key ? { ...entry, record } : entry),
              },
            }
            : current)
        }
      } catch (error) {
        if (!mounted.current) return
        setRowFailures(previous => new Map(previous).set(view.key, toUiFailure(error)))
      } finally {
        if (!mounted.current) return
        setBusyKeys(previous => {
          const nextSet = new Set(previous)
          nextSet.delete(view.key)
          return nextSet
        })
      }
    })()
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searching = normalizedQuery.length > 0
  const snapshot = state.status === 'ready' ? state.snapshot : undefined
  const entries = snapshot?.entries ?? []
  const visible = useMemo(
    () => entries.filter(entry => matches(entry, normalizedQuery)),
    [entries, normalizedQuery],
  )

  return (
    <div className={css.section} data-manage-tab aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status} role="status">{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure} data-list-error data-error-code={state.failure.code}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}

      {snapshot !== undefined ? (
        <>
          <div className={css.toolbar}>
            <label className={css.search}>
              <span className={css.visuallyHidden}>{t('search')}</span>
              <input
                type="search"
                value={query}
                placeholder={t('search')}
                aria-label={t('search')}
                data-manage-filter
                onChange={(event) => { setQuery(event.currentTarget.value) }}
              />
            </label>
            <p className={css.count} data-manage-count>
              {`${String(entries.length)} ${t('countUnit')}`}
            </p>
          </div>

          {entries.length === 0 ? <p className={css.status} role="status">{t('empty')}</p> : null}
          {searching && entries.length > 0 && visible.length === 0 ? (
            <p className={css.status} role="status">{t('emptySearch')}</p>
          ) : null}

          {visible.length > 0 ? (
            <ul className={css.list} data-plugin-list>
              {visible.map(view => {
                const failed = rowFailed(view)
                const stateKind = failed ? 'failed' : view.record.enabled ? 'enabled' : 'disabled'
                const stateText = failed
                  ? t('stateFailed')
                  : view.record.enabled ? t('stateEnabled') : t('stateDisabled')
                const runtimeError = view.runtime.lastError
                return (
                  <li
                    key={view.key}
                    className={css.row}
                    data-plugin-row
                    data-plugin-key={view.key}
                    data-plugin-state={stateKind}
                    data-phase={view.runtime.phase ?? undefined}
                    data-failed={failed ? 'true' : undefined}
                    title={failed && runtimeError !== null ? runtimeError : undefined}
                  >
                    <div className={css.rowMain}>
                      <strong className={css.rowName}>{displayName(view)}</strong>
                      <span className={css.rowMeta}>
                        <span data-source-kind>{view.record.source.kind === 'github' ? t('kindGithub') : view.record.source.kind}</span>
                        <code data-plugin-key-value>{view.key}</code>
                      </span>
                    </div>
                    <div className={css.rowSide}>
                      {view.record.enabled && view.runtime.phase !== null && !failed ? (
                        <span
                          className={css.phaseDot}
                          role="img"
                          aria-label={phaseLabel(view.runtime.phase, t)}
                          title={phaseLabel(view.runtime.phase, t)}
                        />
                      ) : null}
                      <span className={css.stateTag} data-state-tag data-kind={stateKind}>{stateText}</span>
                      <EnableSwitch
                        view={view}
                        busy={busyKeys.has(view.key)}
                        failure={rowFailures.get(view.key)}
                        t={t}
                        onToggle={toggle}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
