/** Full plugin-market settings page: repository status, a "Browse GitHub"
 *  modal (paginated plugin search + install), and the managed roster. */

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GitHubSearchPage,
  ManagedPluginList,
  ManagedPluginPhase,
  ManagedPluginView,
  MarketStatus,
  PluginInstallOutcome,
  PluginInstallReview,
  PluginMarketKey,
  PluginMarketRecord,
  RemoveOutcome,
  RemoveRequest,
} from '../types.ts'
import type { MarketManageLocaleKey } from './locales.ts'
import css from './ManagePluginsTab.module.css'

/** Fixed page size of the GitHub search dialog (mirrors the wire perPage). */
export const SEARCH_PAGE_SIZE = 10

/** Registration-side channel face (lazy closures, wired by apply()). */
export interface ManagePluginsTabInjected {
  /** Read the market activation facts. */
  status: () => Promise<MarketStatus>
  /** Read the record x loader projection of the managed plugins. */
  list: () => Promise<ManagedPluginList>
  /** Persist and apply one record's enablement. */
  setEnabled: (key: PluginMarketKey, enabled: boolean) => Promise<PluginMarketRecord>
  /** Removal step 1: mint a single-use confirmation token. */
  requestRemove: (key: PluginMarketKey) => Promise<RemoveRequest>
  /** Removal step 2: confirm and run the removal. */
  confirmRemove: (key: PluginMarketKey, token: string) => Promise<RemoveOutcome>
  /** One GitHub search page (1-based page, fixed page size). */
  search: (keywords: string, page: number) => Promise<GitHubSearchPage>
  /** Review one repository and mint its single-use install confirmation. */
  previewInstall: (repository: string) => Promise<PluginInstallReview>
  /** Run the double-confirmed install for a reviewed repository. */
  install: (repository: string, confirmToken: string) => Promise<PluginInstallOutcome>
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

type StatusState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly failure: ManageUiFailure }
  | { readonly status: 'idle' }
  | { readonly status: 'configured'; readonly path: string }

const PHASE_KEYS = {
  pending: 'phasePending',
  loading: 'phaseLoading',
  active: 'phaseActive',
  failed: 'phaseFailed',
  unloading: 'phaseUnloading',
} satisfies Record<Exclude<ManagedPluginPhase, null>, MarketManageLocaleKey>

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

/** Localized copy for the stable failure families; others show the code. */
export function failureText(failure: ManageUiFailure, t: Translate): string {
  switch (failure.code) {
    case 'github/rate-limit': return t('rateLimited')
    case 'github/network':
    case 'market/unreachable': return t('networkError')
    case 'github/auth':
    case 'github/not-found': return t('githubAuthError')
    case 'market/confirm-expired': return t('confirmExpired')
    case 'market/confirm-required': return t('confirmRequired')
    case 'market/protected': return t('protectedEntry')
    default: return t('failedWithCode', { code: failure.code })
  }
}

/** Localized accessible label of one live loader phase. */
function phaseLabel(phase: ManagedPluginPhase, t: Translate): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Row failure: an enabled record whose loader fiber failed this session. */
function rowFailed(view: ManagedPluginView): boolean {
  return view.record.enabled
    && (view.runtime.phase === 'failed' || view.runtime.lastError !== null)
}

/** Display name of a managed row: the GitHub slug when the source is GitHub. */
function displayName(view: ManagedPluginView): string {
  const source = view.record.source
  return source.kind === 'github' ? source.repository : view.key
}

/** Whether one managed row matches the local filter query. */
function matches(view: ManagedPluginView, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [displayName(view), view.key].some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** Short display date of an ISO-8601 timestamp (or '' when absent). */
function shortDate(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10)
}
/* ------------------------------------------------------------------------ */
/* Repository status header                                                 */
/* ------------------------------------------------------------------------ */

function StatusHeader({ state, t, onRetry }: {
  readonly state: StatusState
  readonly t: Translate
  readonly onRetry: () => void
}): ReactNode {
  if (state.status === 'loading') {
    return <p className={css.status} role="status">{t('loading')}</p>
  }
  if (state.status === 'error') {
    return (
      <div className={css.failure} data-market-status-error data-error-code={state.failure.code}>
        <p role="alert">{failureText(state.failure, t)}</p>
        <button type="button" onClick={onRetry}>{t('retry')}</button>
      </div>
    )
  }
  if (state.status === 'idle') {
    return (
      <aside className={css.idleCard} data-market-status="idle" role="status">
        <strong>{t('idleTitle')}</strong>
        <p>{t('idleBody')}</p>
      </aside>
    )
  }
  return (
    <p className={css.repoHeader} data-market-status="configured">
      <span className={css.repoLabel}>{t('repoLabel')}</span>
      <code className={css.repoPath} data-market-path title={state.path}>{state.path}</code>
    </p>
  )
}

/* ------------------------------------------------------------------------ */
/* Managed roster section                                                   */
/* ------------------------------------------------------------------------ */

function ManagedList({ snapshot, busyKeys, rowFailures, query, t, onQuery, onToggle, onRemove }: {
  readonly snapshot: ManagedPluginList | undefined
  readonly busyKeys: ReadonlySet<string>
  readonly rowFailures: ReadonlyMap<string, ManageUiFailure>
  readonly query: string
  readonly t: Translate
  readonly onQuery: (query: string) => void
  readonly onToggle: (view: ManagedPluginView) => void
  readonly onRemove: (view: ManagedPluginView) => void
}): ReactNode {
  const normalized = query.trim().toLocaleLowerCase()
  const searching = normalized.length > 0
  const entries = snapshot?.entries ?? []
  const visible = entries.filter(view => matches(view, normalized))

  if (snapshot === undefined) return null

  return (
    <section className={css.section} data-managed-section>
      {entries.length === 0 ? <p className={css.status} role="status">{t('empty')}</p> : null}
      {searching && entries.length > 0 && visible.length === 0 ? (
        <p className={css.status} role="status">{t('emptySearch')}</p>
      ) : null}
      <div className={css.toolbar}>
        <label className={css.search}>
          <span className={css.visuallyHidden}>{t('search')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('search')}
            aria-label={t('search')}
            data-manage-filter
            onChange={(event) => { onQuery(event.currentTarget.value) }}
          />
        </label>
        <p className={css.count} data-manage-count>
          {`${String(entries.length)} ${t('countUnit')}`}
        </p>
      </div>

      {visible.length > 0 ? (
        <ul className={css.list} data-plugin-list>
          {visible.map(view => {
            const failed = rowFailed(view)
            const stateKind = failed ? 'failed' : view.record.enabled ? 'enabled' : 'disabled'
            const stateText = failed
              ? t('stateFailed')
              : view.record.enabled ? t('stateEnabled') : t('stateDisabled')
            const runtimeError = view.runtime.lastError
            const name = displayName(view)
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
                  <strong className={css.rowName}>{name}</strong>
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
                  <button
                    type="button"
                    className={css.textButton}
                    data-remove-trigger
                    onClick={() => { onRemove(view) }}
                  >
                    {t('removeButton')}
                  </button>
                  <button
                    type="button"
                    role="switch"
                    className={css.switch}
                    aria-checked={view.record.enabled}
                    aria-label={view.record.enabled ? t('switchDisable', { name }) : t('switchEnable', { name })}
                    aria-busy={busyKeys.has(view.key)}
                    data-plugin-toggle
                    data-busy={busyKeys.has(view.key) ? 'true' : undefined}
                    disabled={busyKeys.has(view.key)}
                    onClick={() => { onToggle(view) }}
                  />
                </div>
                {rowFailures.get(view.key) === undefined ? null : (
                  <p
                    className={css.rowFailure}
                    role="alert"
                    data-toggle-error
                    data-error-code={rowFailures.get(view.key)!.code}
                    title={rowFailures.get(view.key)!.message}
                  >
                    {t('toggleFailed', { code: rowFailures.get(view.key)!.code })}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
/* ------------------------------------------------------------------------ */
/* Install confirmation dialog (shared by the GitHub modal)                 */
/* ------------------------------------------------------------------------ */

type InstallPhase =
  | { readonly phase: 'preview' }
  | { readonly phase: 'preview-error'; readonly failure: ManageUiFailure }
  | { readonly phase: 'review'; readonly review: PluginInstallReview }
  | { readonly phase: 'installing'; readonly review: PluginInstallReview }
  | { readonly phase: 'install-error'; readonly review: PluginInstallReview; readonly failure: ManageUiFailure }
  | { readonly phase: 'done'; readonly outcome: PluginInstallOutcome }

function InstallDialog({ repository, previewInstall, install, t, onClose, onInstalled }: {
  readonly repository: string
  readonly previewInstall: ManagePluginsTabInjected['previewInstall']
  readonly install: ManagePluginsTabInjected['install']
  readonly t: Translate
  readonly onClose: () => void
  readonly onInstalled: (repository: string) => void
}): ReactNode {
  const mounted = useRef(true)
  const [previewTick, setPreviewTick] = useState(0)
  const [phase, setPhase] = useState<InstallPhase>({ phase: 'preview' })

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let current = true
    setPhase({ phase: 'preview' })
    void Promise.resolve()
      .then(() => previewInstall(repository))
      .then(
        (review) => { if (current) setPhase({ phase: 'review', review }) },
        (error: unknown) => { if (current) setPhase({ phase: 'preview-error', failure: toUiFailure(error) }) },
      )
    return () => { current = false }
  }, [previewInstall, install, previewTick, repository])

  const confirm = (review: PluginInstallReview): void => {
    if (phase.phase === 'installing') return
    setPhase({ phase: 'installing', review })
    void install(repository, review.confirmToken)
      .then(
        (outcome) => {
          if (!mounted.current) return
          setPhase({ phase: 'done', outcome })
          onInstalled(repository)
        },
        (error: unknown) => {
          if (!mounted.current) return
          setPhase({ phase: 'install-error', review, failure: toUiFailure(error) })
        },
      )
  }

  const review = phase.phase === 'review' || phase.phase === 'installing' || phase.phase === 'install-error'
    ? phase.review
    : undefined
  const busy = phase.phase === 'installing' || phase.phase === 'preview'

  return (
    <div className={css.backdrop}>
      <section
        className={css.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('installDialogTitle')}
        data-dialog="install"
      >
        <header className={css.dialogHeader}>
          <strong>{t('installDialogTitle')}</strong>
          <code data-dialog-repository>{repository}</code>
        </header>

        {phase.phase === 'preview' ? <p className={css.status} role="status">{t('loading')}</p> : null}
        {phase.phase === 'preview-error' ? (
          <p className={css.dialogError} role="alert" data-preview-error data-error-code={phase.failure.code}>
            {t('previewFailed')} {failureText(phase.failure, t)}
          </p>
        ) : null}

        {review !== undefined ? (
          <>
            {review.preview.status === 'degraded' ? (
              <p className={css.warning} data-degraded-notice data-degraded-code={review.preview.code}>
                {t('degradedNotice', { code: review.preview.code })}
              </p>
            ) : null}
            {review.exists ? (
              <p className={css.warning} data-overwrite-notice>
                {t('overwriteNotice')}
              </p>
            ) : null}
            <div className={css.deps} data-deps data-preview-status={review.preview.status}>
              <p className={css.depsTitle}>{t('depsTitle')}</p>
              <dl className={css.depsGroups}>
                <div>
                  <dt>{t('depsLabel')}</dt>
                  <dd>
                    {review.preview.summary.dependencies.dependencies.length === 0
                      ? <span data-deps-empty>{t('depsEmpty')}</span>
                      : (
                        <ul data-dep-list>
                          {review.preview.summary.dependencies.dependencies.map(dep => <li key={dep}>{dep}</li>)}
                        </ul>
                      )}
                  </dd>
                </div>
                <div>
                  <dt>{t('peerDepsLabel')}</dt>
                  <dd>
                    {review.preview.summary.dependencies.peerDependencies.length === 0
                      ? <span data-peers-empty>{t('depsEmpty')}</span>
                      : (
                        <ul data-peer-list>
                          {review.preview.summary.dependencies.peerDependencies.map(dep => <li key={dep}>{dep}</li>)}
                        </ul>
                      )}
                  </dd>
                </div>
              </dl>
            </div>
          </>
        ) : null}

        {phase.phase === 'install-error' ? (
          <p className={css.dialogError} role="alert" data-install-error data-error-code={phase.failure.code}>
            {t('installFailed')} {failureText(phase.failure, t)}
          </p>
        ) : null}
        {phase.phase === 'done' ? (
          <p className={css.dialogOk} role="status" data-install-done>
            {t('installDone')}
          </p>
        ) : null}

        <footer className={css.dialogActions}>
          {phase.phase === 'preview-error' ? (
            <button type="button" className={css.primaryButton} data-preview-retry onClick={() => { setPreviewTick(value => value + 1) }}>
              {t('retry')}
            </button>
          ) : null}
          {phase.phase === 'done' ? (
            <button type="button" className={css.primaryButton} data-dialog-done onClick={onClose}>
              {t('doneButton')}
            </button>
          ) : null}
          {phase.phase === 'review' || phase.phase === 'installing' || phase.phase === 'install-error' ? (
            <>
              <button type="button" className={css.primaryButton} data-install-confirm disabled={busy} onClick={() => { confirm(review!) }}>
                {busy ? t('installing') : t('installButton')}
              </button>
              {phase.phase === 'install-error' && phase.failure.code === 'market/confirm-expired' ? (
                <button type="button" data-repreview onClick={() => { setPreviewTick(value => value + 1) }}>
                  {t('retry')}
                </button>
              ) : null}
              <button type="button" className={css.textButton} data-dialog-cancel disabled={busy} onClick={onClose}>
                {t('cancelButton')}
              </button>
            </>
          ) : null}
        </footer>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Removal dialog (two-step double confirmation)                            */
/* ------------------------------------------------------------------------ */

type RemovePhase =
  | { readonly phase: 'ask' }
  | { readonly phase: 'requesting' }
  | { readonly phase: 'second'; readonly request: RemoveRequest }
  | { readonly phase: 'removing'; readonly request: RemoveRequest }

function RemoveDialog({ view, injected, t, onClose, onRemoved }: {
  readonly view: ManagedPluginView
  readonly injected: Pick<ManagePluginsTabInjected, 'requestRemove' | 'confirmRemove'>
  readonly t: Translate
  readonly onClose: () => void
  readonly onRemoved: (key: PluginMarketKey) => void
}): ReactNode {
  const [phase, setPhase] = useState<RemovePhase>({ phase: 'ask' })
  const [failure, setFailure] = useState<ManageUiFailure | undefined>(undefined)
  const name = displayName(view)

  const first = (): void => {
    if (phase.phase === 'requesting') return
    setFailure(undefined)
    setPhase({ phase: 'requesting' })
    void injected.requestRemove(view.key)
      .then(
        (request) => { setPhase({ phase: 'second', request }) },
        (error: unknown) => {
          setFailure(toUiFailure(error))
          setPhase({ phase: 'ask' })
        },
      )
  }

  const second = (): void => {
    const request = phase.phase === 'second' || phase.phase === 'removing' ? phase.request : undefined
    if (request === undefined || phase.phase === 'removing') return
    setFailure(undefined)
    setPhase({ phase: 'removing', request })
    void injected.confirmRemove(view.key, request.token)
      .then(
        () => { onRemoved(view.key) },
        (error: unknown) => {
          setFailure(toUiFailure(error))
          setPhase({ phase: 'second', request })
        },
      )
  }

  const busy = phase.phase === 'requesting' || phase.phase === 'removing'
  const secondVisible = phase.phase === 'second' || phase.phase === 'removing'

  return (
    <div className={css.backdrop}>
      <section
        className={css.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('removeDialogTitle')}
        data-dialog="remove"
        data-remove-key={view.key}
      >
        <header className={css.dialogHeader}>
          <strong>{t('removeDialogTitle')}</strong>
          <code>{view.key}</code>
        </header>

        <p className={css.dialogBody}>{t('removeStep1', { name })}</p>
        {secondVisible ? <p className={css.warning} data-remove-step2>{t('removeStep2')}</p> : null}
        {failure === undefined ? null : (
          <p className={css.dialogError} role="alert" data-remove-error data-error-code={failure.code}>
            {failureText(failure, t)}
          </p>
        )}

        <footer className={css.dialogActions}>
          {secondVisible ? (
            <button type="button" className={css.primaryButton} data-remove-confirm disabled={busy} onClick={second}>
              {busy ? t('removing') : t('removeButton')}
            </button>
          ) : (
            <button type="button" className={css.primaryButton} data-remove-continue disabled={busy} onClick={first}>
              {busy ? t('removing') : t('continueButton')}
            </button>
          )}
          <button type="button" className={css.textButton} data-remove-cancel disabled={busy} onClick={onClose}>
            {t('cancelButton')}
          </button>
        </footer>
      </section>
    </div>
  )
}
/* ------------------------------------------------------------------------ */
/* GitHub browse modal (search + pagination + install entry)                */
/* ------------------------------------------------------------------------ */

type MarketSearchState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading'; readonly keywords: string; readonly page: number }
  | { readonly phase: 'error'; readonly failure: ManageUiFailure; readonly keywords: string; readonly page: number }
  | { readonly phase: 'ready'; readonly pageData: GitHubSearchPage; readonly keywords: string; readonly page: number }

function GitHubDialog({ t, installed, search, previewInstall, install, onClose, onInstalled }: {
  readonly t: Translate
  readonly installed: ReadonlySet<string>
  readonly search: ManagePluginsTabInjected['search']
  readonly previewInstall: ManagePluginsTabInjected['previewInstall']
  readonly install: ManagePluginsTabInjected['install']
  readonly onClose: () => void
  /** Notified after a successful install so the page can refresh the roster. */
  readonly onInstalled: (repository: string) => void
}): ReactNode {
  const mounted = useRef(true)
  const generation = useRef(0)
  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<MarketSearchState>({ phase: 'idle' })
  const [installTarget, setInstallTarget] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const runSearch = (keywords: string, page: number): void => {
    const gen = ++generation.current
    setSearchState({ phase: 'loading', keywords, page })
    void Promise.resolve()
      .then(() => search(keywords, page))
      .then(
        (pageData) => {
          if (!mounted.current || gen !== generation.current) return
          setSearchState({ phase: 'ready', pageData, keywords, page })
        },
        (error: unknown) => {
          if (!mounted.current || gen !== generation.current) return
          setSearchState({ phase: 'error', failure: toUiFailure(error), keywords, page })
        },
      )
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const keywords = query.trim()
    if (keywords.length === 0) return
    runSearch(keywords, 1)
  }

  const goPage = (next: number): void => {
    const current = searchState
    if (current.phase === 'ready' || current.phase === 'error' || current.phase === 'loading') {
      runSearch(current.keywords, next)
    }
  }

  const ready = searchState.phase === 'ready' ? searchState : undefined
  const totalPages = ready === undefined || ready.pageData.totalCount === 0
    ? 0
    : Math.ceil(ready.pageData.totalCount / SEARCH_PAGE_SIZE)
  const installing = installTarget !== null

  return (
    <div className={css.backdrop}>
      <section
        className={css.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('marketDialogTitle')}
        data-dialog="market"
      >
        <header className={css.dialogHeader}>
          <strong>{t('marketDialogTitle')}</strong>
          <button type="button" className={css.textButton} data-market-close onClick={onClose}>
            {t('closeButton')}
          </button>
        </header>

        <form className={css.searchForm} onSubmit={submit}>
          <input
            type="search"
            value={query}
            placeholder={t('githubSearch')}
            aria-label={t('githubSearch')}
            data-market-search-input
            onChange={(event) => { setQuery(event.currentTarget.value) }}
          />
          <button
            type="submit"
            className={css.primaryButton}
            data-market-search-submit
            disabled={query.trim().length === 0 || searchState.phase === 'loading'}
          >
            {searchState.phase === 'loading' ? t('searching') : t('searchButton')}
          </button>
        </form>

        {searchState.phase === 'idle' ? <p className={css.hint} data-market-idle>{t('searchIdle')}</p> : null}
        {searchState.phase === 'loading' ? <p className={css.status} role="status" data-market-loading>{t('searching')}</p> : null}
        {searchState.phase === 'error' ? (
          <p className={css.dialogError} role="alert" data-market-error data-error-code={searchState.failure.code}>
            {failureText(searchState.failure, t)}
          </p>
        ) : null}
        {searchState.phase === 'ready' && searchState.pageData.items.length === 0 ? (
          <p className={css.status} role="status" data-market-empty>{t('searchEmpty')}</p>
        ) : null}

        {ready !== undefined && ready.pageData.items.length > 0 ? (
          <>
            <ul className={css.resultList} data-market-results>
              {ready.pageData.items.map(item => {
                const managed = installed.has(item.repository)
                return (
                  <li key={item.repository} className={css.resultCard} data-market-card data-repository={item.repository}>
                    <div className={css.resultMain}>
                      <a
                        className={css.resultName}
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        data-market-link
                        title={item.repository}
                      >
                        {item.name}
                      </a>
                      {item.description === null ? null : (
                        <p className={css.resultDescription} data-result-description>{item.description}</p>
                      )}
                      <span className={css.resultMeta}>
                        <span data-result-stars>{t('starsLabel', { count: String(item.stars) })}</span>
                        {item.updatedAt === null ? null : (
                          <span data-result-updated>{t('updatedLabel', { date: shortDate(item.updatedAt) })}</span>
                        )}
                        <a className={css.externalLink} href={item.url} target="_blank" rel="noreferrer">
                          {t('repoLinkLabel')}
                        </a>
                      </span>
                    </div>
                    <div className={css.resultActions}>
                      {managed ? (
                        <span className={css.installedBadge} data-installed>{t('installedBadge')}</span>
                      ) : null}
                      <button
                        type="button"
                        className={css.primaryButton}
                        data-install-trigger
                        data-install-repository={item.repository}
                        disabled={managed}
                        onClick={() => { if (!managed) setInstallTarget(item.repository) }}
                      >
                        {t('installButton')}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>

            <footer className={css.pagination} data-pagination>
              <button
                type="button"
                className={css.textButton}
                data-page-prev
                disabled={ready.page <= 1 || searchState.phase === 'loading'}
                onClick={() => { goPage(ready.page - 1) }}
              >
                {t('prevPage')}
              </button>
              <p className={css.count} data-page-count>
                {t('pagination', {
                  current: String(ready.page),
                  total: String(Math.max(totalPages, 1)),
                  count: String(ready.pageData.totalCount),
                })}
              </p>
              <button
                type="button"
                className={css.textButton}
                data-page-next
                disabled={totalPages === 0 || ready.page >= totalPages || searchState.phase === 'loading'}
                onClick={() => { goPage(ready.page + 1) }}
              >
                {t('nextPage')}
              </button>
            </footer>
          </>
        ) : null}

        {installing ? (
          <InstallDialog
            key={installTarget}
            repository={installTarget!}
            previewInstall={previewInstall}
            install={install}
            t={t}
            onClose={() => { setInstallTarget(null) }}
            onInstalled={(repository) => { onInstalled(repository) }}
          />
        ) : null}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Page                                                                     */
/* ------------------------------------------------------------------------ */

/** Render the full managed-plugins settings page. */
export function ManagePluginsTab(props: ManagePluginsTabProps): ReactNode {
  const {
    status: readStatus, list, setEnabled, requestRemove, confirmRemove,
    search, previewInstall, install, t,
  } = props
  const mounted = useRef(true)
  const [statusState, setStatusState] = useState<StatusState>({ status: 'loading' })
  const [listState, setListState] = useState<ViewState>({ status: 'loading' })
  const [listRequest, setListRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [rowFailures, setRowFailures] = useState<ReadonlyMap<string, ManageUiFailure>>(() => new Map())
  const [marketOpen, setMarketOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<ManagedPluginView | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadStatus = (): void => {
    setStatusState({ status: 'loading' })
    void Promise.resolve()
      .then(() => readStatus())
      .then(
        (statusValue) => {
          if (!mounted.current) return
          setStatusState(statusValue.configured
            ? { status: 'configured', path: statusValue.repositoryPath ?? '' }
            : { status: 'idle' })
        },
        (error: unknown) => {
          if (!mounted.current) return
          setStatusState({ status: 'error', failure: toUiFailure(error) })
        },
      )
  }

  useEffect(() => {
    let current = true
    void Promise.resolve()
      .then(() => list())
      .then(
        (snapshot) => { if (current) setListState({ status: 'ready', snapshot }) },
        (error: unknown) => { if (current) setListState({ status: 'error', failure: toUiFailure(error) }) },
      )
    return () => { current = false }
  }, [list, listRequest])

  useEffect(() => { loadStatus() }, [readStatus])

  const retryList = (): void => {
    setListState({ status: 'loading' })
    setListRequest(value => value + 1)
  }

  const reloadList = (): void => {
    void Promise.resolve()
      .then(() => list())
      .then(
        (snapshot) => { if (mounted.current) setListState({ status: 'ready', snapshot }) },
        () => { if (mounted.current) retryList() },
      )
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
        try {
          const snapshot = await list()
          if (!mounted.current) return
          setListState({ status: 'ready', snapshot })
        } catch {
          if (!mounted.current) return
          setListState(current => current.status === 'ready'
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

  /** Installed markers: repositories recorded by the market (GitHub only). */
  const installedRepositories = useMemo(() => {
    const found = new Set<string>()
    if (listState.status !== 'ready') return found
    for (const view of listState.snapshot.entries) {
      const source = view.record.source
      if (source.kind === 'github') found.add(source.repository)
    }
    return found
  }, [listState])

  const configured = statusState.status === 'configured'

  return (
    <div className={css.page} data-manage-tab>
      <StatusHeader state={statusState} t={t} onRetry={loadStatus} />

      {configured ? (
        <>
          <div className={css.pageToolbar}>
            <h3 className={css.heading} data-managed-heading>{t('managedHeading')}</h3>
            <button
              type="button"
              className={css.primaryButton}
              data-open-market
              onClick={() => { setMarketOpen(true) }}
            >
              {t('openMarket')}
            </button>
          </div>
          {listState.status === 'error' ? (
            <div className={css.failure} data-list-error data-error-code={listState.failure.code}>
              <p role="alert">{t('error')}</p>
              <button type="button" onClick={retryList}>{t('retry')}</button>
            </div>
          ) : null}
          {listState.status === 'loading' ? (
            <p className={css.status} role="status" data-managed-loading>{t('loading')}</p>
          ) : null}
          <ManagedList
            snapshot={listState.status === 'ready' ? listState.snapshot : undefined}
            busyKeys={busyKeys}
            rowFailures={rowFailures}
            query={query}
            t={t}
            onQuery={setQuery}
            onToggle={toggle}
            onRemove={(view) => { setRemoveTarget(view) }}
          />
        </>
      ) : null}

      {marketOpen ? (
        <GitHubDialog
          key="market"
          t={t}
          installed={installedRepositories}
          search={search}
          previewInstall={previewInstall}
          install={install}
          onClose={() => { setMarketOpen(false) }}
          onInstalled={(repository) => { reloadList(); void repository }}
        />
      ) : null}

      {removeTarget !== null ? (
        <RemoveDialog
          key={removeTarget.key}
          view={removeTarget}
          injected={{ requestRemove, confirmRemove }}
          t={t}
          onClose={() => { setRemoveTarget(null) }}
          onRemoved={(key) => {
            setRemoveTarget(null)
            setListState(current => current.status === 'ready'
              ? {
                status: 'ready',
                snapshot: { entries: current.snapshot.entries.filter(entry => entry.key !== key) },
              }
              : current)
            reloadList()
          }}
        />
      ) : null}
    </div>
  )
}

