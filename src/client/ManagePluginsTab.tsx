/** Full plugin-market settings page: repository status, a "Browse GitHub"
 *  modal (paginated plugin search + install), and the managed roster. */

import {
  useEffect, useId, useMemo, useRef, useState,
  type FormEvent, type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject,
} from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GitHubSearchPage,
  GithubRefKind,
  ManagedPluginList,
  ManagedPluginPhase,
  ManagedPluginView,
  MarketCheckoutKind,
  MarketStatus,
  PluginInstallOutcome,
  PluginInstallReview,
  PluginMarketKey,
  PluginMarketRecord,
  RemoveOutcome,
  RemoveRequest,
  RepositoryDetail,
} from '../types.ts'
import { renderReadmeHtml } from './readme.ts'
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
  /** Aggregated repository detail (metadata, refs, README). */
  repositoryDetail: (repository: string) => Promise<RepositoryDetail>
  /** Review one repository ref and mint its single-use install confirmation.
   *  `version` null/omitted + no `refKind` reviews the default branch the
   *  legacy way; a v2 per-ref review pairs `version` with `refKind`. */
  previewInstall: (
    repository: string,
    version?: string | null,
    refKind?: GithubRefKind,
  ) => Promise<PluginInstallReview>
  /** Run the double-confirmed install for a reviewed repository ref; the
   *  optional `refKind`/`version` pair must reproduce the reviewed tuple. */
  install: (
    repository: string,
    confirmToken: string,
    version?: string | null,
    refKind?: GithubRefKind,
  ) => Promise<PluginInstallOutcome>
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
    case 'github/auth': return t('githubAuthError')
    case 'github/not-found': return t('githubNotFound')
    case 'market/confirm-expired': return t('confirmExpired')
    case 'market/confirm-required': return t('confirmRequired')
    case 'market/protected': return t('protectedEntry')
    case 'market/llm-unconfigured': return t('analysisNotConfigured')
    case 'market/llm-failed': return t('analysisModelFailed')
    case 'market/llm-bad-output': return t('analysisBadOutput')
    default: return t('failedWithCode', { code: failure.code })
  }
}

/** Whether a failure code belongs to the smart-install analysis family. */
export function isAnalysisFailureCode(code: string): boolean {
  return code === 'market/llm-unconfigured'
    || code === 'market/llm-failed'
    || code === 'market/llm-bad-output'
}

/** Focusable controls of one modal dialog (Tab-trap candidates). */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * Modal-dialog keyboard accessibility shared by every dialog shell: move the
 * initial focus onto the dialog, close it on Escape when a dismiss/cancel
 * semantic exists, and keep Tab looping inside the dialog (a simple trap that
 * never lets the focus escape into the page or a sibling dialog). Escape stops
 * propagation so a nested dialog (install on top of market) closes first and
 * never closes its outer owner.
 */
function useDialogA11y(dialogRef: RefObject<HTMLElement | null>, dismissible: boolean, onClose: () => void): void {
  useEffect(() => {
    dialogRef.current?.focus()
  }, [dialogRef])

  useEffect(() => {
    const node = dialogRef.current
    if (node === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (dismissible) onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusables.length === 0) return
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const index = active !== null ? focusables.indexOf(active) : -1
      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault()
          focusables[focusables.length - 1]?.focus()
        }
        return
      }
      if (index === -1 || index === focusables.length - 1) {
        event.preventDefault()
        focusables[0]?.focus()
      }
    }
    node.addEventListener('keydown', onKeyDown)
    return () => { node.removeEventListener('keydown', onKeyDown) }
  }, [dialogRef, dismissible, onClose])
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
          <span className={css.visuallyHidden}>{t('filterPlaceholder')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('filterPlaceholder')}
            aria-label={t('filterPlaceholder')}
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

/** Localized refusal-heading key of one analysis kind. The `plugin` kind is
 *  the build-first refusal; `tooling` and `other` share the generic copy. */
const ANALYSIS_KIND_KEYS = {
  plugin: 'analysisKindBuild',
  skills: 'analysisKindSkills',
  preset: 'analysisKindPreset',
  tooling: 'analysisKindTooling',
  other: 'analysisKindOther',
} satisfies Record<MarketCheckoutKind, MarketManageLocaleKey>

/** Localized refusal heading of one review analysis verdict. */
function analysisKindText(kind: MarketCheckoutKind, t: Translate): string {
  return t(ANALYSIS_KIND_KEYS[kind])
}

function InstallDialog({ repository, version, refKind, previewInstall, install, t, onClose, onInstalled }: {
  readonly repository: string
  /** Branch/tag ref name being installed; null = the legacy default branch. */
  readonly version?: string | null
  /** V2 ref kind of the pinned branch/tag (omitted on legacy reviews). */
  readonly refKind?: GithubRefKind
  readonly previewInstall: ManagePluginsTabInjected['previewInstall']
  readonly install: ManagePluginsTabInjected['install']
  readonly t: Translate
  readonly onClose: () => void
  readonly onInstalled: (repository: string) => void
}): ReactNode {
  const mounted = useRef(true)
  const dialogRef = useRef<HTMLElement | null>(null)
  const [previewTick, setPreviewTick] = useState(0)
  const [phase, setPhase] = useState<InstallPhase>({ phase: 'preview' })

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Esc closes the review dialog whenever no install is in flight; the focus
  // is moved onto the dialog on mount and Tab never leaves it.
  useDialogA11y(dialogRef, phase.phase !== 'installing', onClose)

  useEffect(() => {
    let current = true
    setPhase({ phase: 'preview' })
    void Promise.resolve()
      .then(() => previewInstall(repository, version ?? null, refKind))
      .then(
        (review) => { if (current) setPhase({ phase: 'review', review }) },
        (error: unknown) => { if (current) setPhase({ phase: 'preview-error', failure: toUiFailure(error) }) },
      )
    return () => { current = false }
  }, [previewInstall, previewTick, repository, version, refKind])

  const confirm = (review: PluginInstallReview): void => {
    if (phase.phase === 'installing') return
    setPhase({ phase: 'installing', review })
    void install(repository, review.confirmToken, version ?? null, refKind)
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
  /** Smart-analysis refusal attached to the review: the candidate is not
   *  installable, so the confirmation flow is replaced by the refusal state. */
  const refusal = review?.analysis
  const busy = phase.phase === 'installing' || phase.phase === 'preview'

  return (
    <div className={css.backdrop}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={css.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('installDialogTitle')}
        data-dialog="install"
      >
        <header className={css.dialogHeader}>
          <strong>{t('installDialogTitle')}</strong>
          {version === undefined || version === null ? (
            <code data-dialog-repository>{repository}</code>
          ) : (
            <code data-dialog-repository data-install-version={version}>{`${repository}@${version}`}</code>
          )}
        </header>

        {phase.phase === 'preview' ? <p className={css.status} role="status" data-preview-loading>{t('previewing')}</p> : null}
        {phase.phase === 'preview-error' ? (
          <div>
            <p className={css.dialogError} role="alert" data-preview-error data-error-code={phase.failure.code}>
              {isAnalysisFailureCode(phase.failure.code)
                ? failureText(phase.failure, t)
                : `${t('previewFailed')} ${failureText(phase.failure, t)}`}
            </p>
            {phase.failure.code === 'market/llm-unconfigured' ? (
              <p className={css.analysisGuide} data-analysis-guide>{t('analysisConfigGuide')}</p>
            ) : null}
          </div>
        ) : null}

        {refusal !== undefined ? (
          <div className={css.analysisBlock} data-analysis-blocked data-analysis-kind={refusal.kind}>
            <p className={css.analysisTitle} role="status" data-analysis-title>
              {analysisKindText(refusal.kind, t)}
            </p>
            <p className={css.analysisReason} data-analysis-reason>{refusal.reason}</p>
          </div>
        ) : null}

        {review !== undefined && refusal === undefined ? (
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
          {refusal !== undefined ? (
            <button type="button" className={css.textButton} data-analysis-close onClick={onClose}>
              {t('closeButton')}
            </button>
          ) : null}
          {phase.phase === 'preview-error' ? (
            <>
              {phase.failure.code === 'market/llm-unconfigured' ? null : (
                <button type="button" className={css.primaryButton} data-preview-retry onClick={() => { setPreviewTick(value => value + 1) }}>
                  {t('retry')}
                </button>
              )}
              {isAnalysisFailureCode(phase.failure.code) ? (
                <button type="button" className={css.textButton} data-analysis-close onClick={onClose}>
                  {t('closeButton')}
                </button>
              ) : (
                <button type="button" className={css.textButton} data-dialog-cancel onClick={onClose}>
                  {t('cancelButton')}
                </button>
              )}
            </>
          ) : null}
          {phase.phase === 'done' ? (
            <button type="button" className={css.primaryButton} data-dialog-done onClick={onClose}>
              {t('doneButton')}
            </button>
          ) : null}
          {phase.phase === 'review' || phase.phase === 'installing' || phase.phase === 'install-error' ? (
            refusal === undefined ? (
              <>
                <button type="button" className={css.primaryButton} data-install-confirm disabled={busy} onClick={() => { confirm(review!) }}>
                  {busy ? t('installing') : t('installButton')}
                </button>
                {phase.phase === 'install-error' ? (
                  // Every install failure (not only a consumed confirmation)
                  // offers a fresh review: the old token may be spent already.
                  <button type="button" data-repreview onClick={() => { setPreviewTick(value => value + 1) }}>
                    {t('repreviewButton')}
                  </button>
                ) : null}
                <button type="button" className={css.textButton} data-dialog-cancel disabled={busy} onClick={onClose}>
                  {t('cancelButton')}
                </button>
              </>
            ) : null
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
  const dialogRef = useRef<HTMLElement | null>(null)
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

  // Esc dismisses the removal dialog whenever no removal request is in flight.
  useDialogA11y(dialogRef, !busy, onClose)

  return (
    <div className={css.backdrop}>
      <section
        ref={dialogRef}
        tabIndex={-1}
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

/** Minimum gap kept between a dragged dialog and the viewport edges. */
const DRAG_VIEWPORT_EDGE = 8

/** One in-flight pointer drag of the market dialog (desktop title bar). */
interface MarketDragAnchor {
  readonly pointerX: number
  readonly pointerY: number
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** Clamp a dragged dialog origin so the whole box stays inside the viewport. */
function clampToViewport(
  left: number,
  top: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const edge = DRAG_VIEWPORT_EDGE
  return {
    left: Math.min(Math.max(left, edge), Math.max(edge, window.innerWidth - width - edge)),
    top: Math.min(Math.max(top, edge), Math.max(edge, window.innerHeight - height - edge)),
  }
}

/** dsh close glyph (ic_ds_close_outline_16 rendered at 14px, × shape). */
function CloseGlyph(): ReactNode {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d="M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z" fill="currentColor" />
      <path d="M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z" fill="currentColor" />
    </svg>
  )
}

/** Whether an event target is an interactive child that must not start a drag. */
function isInteractive(eventTarget: EventTarget): boolean {
  return eventTarget instanceof Element
    && eventTarget.closest('button, a, input, textarea, select, [role="switch"], [contenteditable="true"]') !== null
}

type MarketSearchState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading'; readonly keywords: string; readonly page: number }
  | { readonly phase: 'error'; readonly failure: ManageUiFailure; readonly keywords: string; readonly page: number }
  | { readonly phase: 'ready'; readonly pageData: GitHubSearchPage; readonly keywords: string; readonly page: number }

/** One install target selected from the detail view (branch or tag). */
interface MarketInstallTarget {
  readonly repository: string
  /** Branch/tag ref name to install (the picker always supplies one). */
  readonly version: string
  /** Kind of the selected ref: keeps same-name branches and tags apart. */
  readonly refKind: RefKind
}

/** Load state of the repository detail view. */
type MarketDetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly failure: ManageUiFailure }
  | { readonly status: 'ready'; readonly detail: RepositoryDetail }

/**
 * Installed-ref projection of one repository. Names come in two families:
 * kind-tagged v2 refs (matched by kind AND name, so a same-name branch and
 * tag never cross-mark) and legacy refs from records without ref metadata
 * (matched by name alone, the pre-v2 fallback).
 */
export interface InstalledRefs {
  /** Names of legacy (refKind-less) records — matched by name alone. */
  readonly legacy: ReadonlySet<string>
  /** Names of v2 records per kind — matched by kind AND name. */
  readonly byKind: Readonly<Record<RefKind, ReadonlySet<string>>>
}

/** Per-repository installed-ref projection (marker input of the detail view). */
export type InstalledRefsByRepository = ReadonlyMap<string, InstalledRefs>

/** Whether the roster marks this exact (kind, name) ref of the repository. */
function isRefInstalled(
  installedRefs: InstalledRefsByRepository,
  repository: string,
  choice: RefChoice,
): boolean {
  const refs = installedRefs.get(repository)
  if (refs === undefined) return false
  return refs.legacy.has(choice.name)
    || refs.byKind[choice.kind].has(choice.name)
}

/* ------------------------------------------------------------------------ */
/* Merged branch/tag picker model                                            */
/* ------------------------------------------------------------------------ */

/** One installable ref of a repository: a branch or a tag. */
export type RefKind = GithubRefKind

/** One installable ref of a repository: a branch or a tag. */
export interface RefChoice {
  readonly kind: RefKind
  readonly name: string
}

const BRANCH_VALUE_PREFIX = 'branch:'
const TAG_VALUE_PREFIX = 'tag:'

/** Encode one ref into its dropdown value so the kind survives selection. */
export function refValueOf(choice: RefChoice): string {
  return `${choice.kind}:${choice.name}`
}

/** Decode a dropdown value; null = the empty "select…" placeholder. */
export function parseRefValue(value: string): RefChoice | null {
  if (value.startsWith(BRANCH_VALUE_PREFIX)) {
    return { kind: 'branch', name: value.slice(BRANCH_VALUE_PREFIX.length) }
  }
  if (value.startsWith(TAG_VALUE_PREFIX)) {
    return { kind: 'tag', name: value.slice(TAG_VALUE_PREFIX.length) }
  }
  return null
}

/** Branch names with the default branch pinned first (whenever it is listed). */
function orderedBranchNames(
  branches: readonly string[],
  defaultBranch: string,
): readonly string[] {
  if (!branches.includes(defaultBranch)) return branches
  return [defaultBranch, ...branches.filter(name => name !== defaultBranch)]
}

/** Human dropdown text of one ref: the name plus optional localized marks. */
function refDisplayText(
  choice: RefChoice,
  defaultBranch: string,
  installed: boolean,
  t: Translate,
): string {
  const marks: string[] = []
  if (choice.kind === 'branch' && choice.name === defaultBranch) {
    marks.push(t('defaultBranchLabel'))
  }
  if (installed) marks.push(t('installedBadge'))
  return marks.length === 0 ? choice.name : `${choice.name} (${marks.join(', ')})`
}

/**
 * README block of the detail view. Renders marked → DOMPurify under the
 * `.marketReadme` scope class; a null HTML result (unexpected render error)
 * surfaces as a localized failure instead of raw markdown.
 */
function DetailReadme({ readme, url, defaultBranch, t }: {
  readonly readme: string
  readonly url: string
  readonly defaultBranch: string
  readonly t: Translate
}): ReactNode {
  const html = useMemo(() => {
    try {
      return renderReadmeHtml(readme, { url, defaultBranch })
    } catch {
      return null
    }
  }, [readme, url, defaultBranch])
  if (html === null) {
    return <p className={css.status} role="alert" data-readme-error>{t('detailError')}</p>
  }
  return <div className={css.marketReadme} data-readme dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * Ready detail content: repository metadata header, one merged branch/tag
 * dropdown with the single install action below it, and the README block.
 * Rendered inside the modal's scrolling zone so long README documents scroll
 * instead of stretching the dialog shell.
 */
function RepositoryDetailBody({ detail, installedRefs, t, onInstall }: {
  readonly detail: RepositoryDetail
  readonly installedRefs: InstalledRefsByRepository
  readonly t: Translate
  /** Open the install review for one branch/tag ref of this repository. */
  readonly onInstall: (choice: RefChoice) => void
}): ReactNode {
  const selectId = useId()
  const [selectedValue, setSelectedValue] = useState('')
  const hasRefs = detail.branches.length > 0 || detail.tags.length > 0
  const selection = parseRefValue(selectedValue)
  const selectedInstalled = selection !== null
    && isRefInstalled(installedRefs, detail.repository, selection)
  const branchChoices: readonly RefChoice[] =
    orderedBranchNames(detail.branches, detail.defaultBranch).map(name => ({ kind: 'branch', name }))
  const tagChoices: readonly RefChoice[] =
    detail.tags.map(name => ({ kind: 'tag', name }))

  const renderOption = (choice: RefChoice): ReactNode => {
    const installed = isRefInstalled(installedRefs, detail.repository, choice)
    const isDefault = choice.kind === 'branch' && choice.name === detail.defaultBranch
    return (
      <option
        key={refValueOf(choice)}
        value={refValueOf(choice)}
        data-ref-option
        data-ref-kind={choice.kind}
        data-ref-name={choice.name}
        data-default-branch={isDefault ? 'true' : undefined}
        data-ref-installed={installed ? 'true' : undefined}
      >
        {refDisplayText(choice, detail.defaultBranch, installed, t)}
      </option>
    )
  }

  return (
    <div className={css.detailBody} data-detail-view data-repository={detail.repository}>
      <div className={css.detailHeader} data-detail-header>
        <a
          className={css.detailName}
          href={detail.url}
          target="_blank"
          rel="noreferrer"
          data-detail-name
          title={detail.repository}
        >
          {detail.name}
        </a>
        {detail.description === null ? null : (
          <p className={css.detailDescription} data-detail-description>{detail.description}</p>
        )}
        <span className={css.resultMeta} data-detail-meta>
          <span data-detail-stars>{t('starsLabel', { count: String(detail.stars) })}</span>
          {detail.updatedAt === null ? null : (
            <span data-detail-updated>{t('updatedLabel', { date: shortDate(detail.updatedAt) })}</span>
          )}
          <a className={css.externalLink} href={detail.url} target="_blank" rel="noreferrer" data-detail-link>
            {t('repoLinkLabel')}
          </a>
        </span>
      </div>

      {!hasRefs ? <p className={css.status} role="status" data-detail-empty>{t('detailEmpty')}</p> : (
        <section className={css.refPicker} data-ref-picker aria-label={t('refSelectLabel')}>
          <label className={css.groupTitle} data-ref-picker-label htmlFor={selectId}>
            {t('refSelectLabel')}
          </label>
          <select
            id={selectId}
            className={css.refSelect}
            value={selectedValue}
            aria-label={t('refSelectLabel')}
            data-ref-select
            onChange={(event) => { setSelectedValue(event.currentTarget.value) }}
          >
            <option value="" data-ref-placeholder>{t('refSelectPlaceholder')}</option>
            {branchChoices.length === 0 ? null : (
              <optgroup label={t('branchesTitle')} data-ref-optgroup data-ref-kind="branch">
                {branchChoices.map(renderOption)}
              </optgroup>
            )}
            {tagChoices.length === 0 ? null : (
              <optgroup label={t('tagsTitle')} data-ref-optgroup data-ref-kind="tag">
                {tagChoices.map(renderOption)}
              </optgroup>
            )}
          </select>
          <div className={css.refPickerActions}>
            <button
              type="button"
              className={css.primaryButton}
              data-ref-install
              disabled={selection === null || selectedInstalled}
              onClick={() => { if (selection !== null) onInstall(selection) }}
            >
              {selectedInstalled ? t('installedBadge') : t('installButton')}
            </button>
          </div>
        </section>
      )}

      <section className={css.readmeSection} data-readme-section aria-label={t('readmeHeading')}>
        <h4 className={css.groupTitle} data-readme-title>{t('readmeHeading')}</h4>
        {detail.readme === null ? (
          <p className={css.status} role="status" data-readme-empty>{t('noReadme')}</p>
        ) : (
          <DetailReadme
            readme={detail.readme}
            url={detail.url}
            defaultBranch={detail.defaultBranch}
            t={t}
          />
        )}
      </section>
    </div>
  )
}


/**
 * Detail view of one repository: localizes the load states and hands the ready
 * detail to {@link RepositoryDetailBody}. Lives inside the shared modal shell
 * and its scrolling zone; the list search/pagination are hidden while it is up.
 */
function RepositoryDetailPane({ slug, state, installedRefs, t, onRetry, onInstall }: {
  readonly slug: string
  readonly state: MarketDetailState
  readonly installedRefs: InstalledRefsByRepository
  readonly t: Translate
  readonly onRetry: () => void
  readonly onInstall: (choice: RefChoice) => void
}): ReactNode {
  return (
    <div data-detail-pane data-detail-slug={slug}>
      {state.status === 'loading' ? (
        <p className={css.status} role="status" data-detail-loading>{t('detailLoading')}</p>
      ) : null}
      {state.status === 'error' ? (
        <div className={css.marketError} role="alert" data-detail-error data-error-code={state.failure.code}>
          <p>{failureText(state.failure, t)}</p>
          <button type="button" className={css.textButton} data-detail-retry onClick={onRetry}>
            {t('retry')}
          </button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <RepositoryDetailBody
          detail={state.detail}
          installedRefs={installedRefs}
          t={t}
          onInstall={onInstall}
        />
      ) : null}
    </div>
  )
}

function GitHubDialog({ t, installed, installedRefs, search, repositoryDetail, previewInstall, install, onClose, onInstalled }: {
  readonly t: Translate
  /** Repositories that already own a managed record (row badge markers). */
  readonly installed: ReadonlySet<string>
  /** Kind-aware installed-ref markers per repository (detail-view dropdown). */
  readonly installedRefs: InstalledRefsByRepository
  readonly search: ManagePluginsTabInjected['search']
  readonly repositoryDetail: ManagePluginsTabInjected['repositoryDetail']
  readonly previewInstall: ManagePluginsTabInjected['previewInstall']
  readonly install: ManagePluginsTabInjected['install']
  readonly onClose: () => void
  /** Notified after a successful install so the page can refresh the roster. */
  readonly onInstalled: (repository: string) => void
}): ReactNode {
  const mounted = useRef(true)
  const dialogRef = useRef<HTMLElement | null>(null)
  const generation = useRef(0)
  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<MarketSearchState>({ phase: 'idle' })
  /** Open detail slug: null shows the search/list view. */
  const [detailSlug, setDetailSlug] = useState<string | null>(null)
  const [detailTick, setDetailTick] = useState(0)
  const [detailState, setDetailState] = useState<MarketDetailState>({ status: 'loading' })
  const [installTarget, setInstallTarget] = useState<MarketInstallTarget | null>(null)
  const [jumpValue, setJumpValue] = useState('')
  const [dragPosition, setDragPosition] = useState<{ left: number; top: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragAnchor = useRef<MarketDragAnchor | null>(null)
  const detachDrag = useRef<(() => void) | null>(null)
  /** One empty-keyword auto browse per mounted dialog (never on later clears). */
  const autoBrowsed = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // Never leave move/up listeners behind when the dialog unmounts mid-drag.
      detachDrag.current?.()
    }
  }, [])

  /**
   * Detail load: runs whenever a slug is opened (or the retry tick fires).
   * Search generations are untouched — a detail response that resolves after
   * the user pressed back (slug null) is dropped by the closure guard.
   */
  useEffect(() => {
    const slug = detailSlug
    if (slug === null) return
    let current = true
    setDetailState({ status: 'loading' })
    void Promise.resolve()
      .then(() => repositoryDetail(slug))
      .then(
        (detail) => { if (current && mounted.current) setDetailState({ status: 'ready', detail }) },
        (error: unknown) => { if (current && mounted.current) setDetailState({ status: 'error', failure: toUiFailure(error) }) },
      )
    return () => { current = false }
  }, [detailSlug, detailTick, repositoryDetail])

  /** Back to the list view; the search keywords/page state is untouched. */
  const goBackToList = (): void => {
    setDetailState({ status: 'loading' })
    setDetailSlug(null)
  }

  /** Open the install review for one branch/tag ref of the shown repository. */
  const openRefInstall = (repository: string, choice: RefChoice): void => {
    setInstallTarget({ repository, version: choice.name, refKind: choice.kind })
  }

  const detailInView = detailSlug !== null

  /**
   * Begin dragging the dialog from its title bar. Interactive children (the
   * close button) never start a drag, so close and drag stay conflict-free.
   */
  const beginDrag = (event: ReactMouseEvent<HTMLElement>): void => {
    if (event.button !== 0 || dragAnchor.current !== null || isInteractive(event.target)) return
    const dialog = event.currentTarget.closest('[data-dialog]')
    if (!(dialog instanceof HTMLElement)) return
    event.preventDefault()
    const rect = dialog.getBoundingClientRect()
    const anchor: MarketDragAnchor = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    }
    dragAnchor.current = anchor
    setDragging(true)
    setDragPosition(clampToViewport(anchor.left, anchor.top, anchor.width, anchor.height))

    const onMove = (moveEvent: MouseEvent): void => {
      const start = dragAnchor.current
      if (start === null) return
      setDragPosition(clampToViewport(
        start.left + moveEvent.clientX - start.pointerX,
        start.top + moveEvent.clientY - start.pointerY,
        start.width,
        start.height,
      ))
    }
    const finish = (): void => {
      dragAnchor.current = null
      setDragging(false)
      detachDrag.current?.()
    }
    detachDrag.current = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', finish)
      window.removeEventListener('blur', finish)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', finish)
    window.addEventListener('blur', finish)
  }

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

  // One-shot browse: on the very first mount with an empty search box, list
  // every dsh plugin (empty keyword = Host topic:dsh-plugin search). Later
  // edits/clears never auto-resubmit; only an explicit submit (or retry) does.
  useEffect(() => {
    if (autoBrowsed.current) return
    autoBrowsed.current = true
    if (query.trim().length === 0) runSearch('', 1)
    // Deliberately mount-only; a reopened dialog mounts fresh and browses again.
  }, [])

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

  /** Jump to an explicit page: clamp 1..totalPages; invalid input no-ops. */
  const commitJump = (): void => {
    if (ready === undefined || searchState.phase === 'loading') return
    const parsed = Number.parseInt(jumpValue.trim(), 10)
    setJumpValue('')
    if (!Number.isFinite(parsed)) return
    const target = Math.min(Math.max(parsed, 1), Math.max(totalPages, 1))
    if (target !== ready.page) runSearch(ready.keywords, target)
  }

  const onJumpKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitJump()
  }

  // The market modal is always dismissible; a nested install dialog handles
  // its own Escape first and never bubbles into this one.
  useDialogA11y(dialogRef, true, onClose)

  return (
    <div className={css.backdrop}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={`${css.dialog} ${css.marketDialog}${dragging ? ` ${css.marketDragging}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('marketDialogTitle')}
        data-dialog="market"
        style={dragPosition === null ? undefined : {
          position: 'fixed',
          left: `${dragPosition.left}px`,
          top: `${dragPosition.top}px`,
        }}
      >
        <header
          className={`${css.dialogHeader} ${css.dragHandle}`}
          data-drag-handle
          onMouseDown={beginDrag}
        >
          <span className={css.dialogTitleRow}>
            {detailInView ? (
              <button
                type="button"
                className={css.textButton}
                data-detail-back
                onClick={goBackToList}
              >
                {t('detailBack')}
              </button>
            ) : null}
            <strong>{detailInView ? t('detailTitle') : t('marketDialogTitle')}</strong>
          </span>
          <button
            type="button"
            className={css.dialogClose}
            data-market-close
            aria-label={t('closeButton')}
            onClick={onClose}
          >
            <CloseGlyph />
          </button>
        </header>

        {detailSlug === null ? (
          <>
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

            <div className={css.marketScroll} data-market-scroll>
              {searchState.phase === 'idle' ? <p className={css.hint} data-market-idle>{t('searchIdle')}</p> : null}
              {searchState.phase === 'loading' ? <p className={css.status} role="status" data-market-loading>{t('searching')}</p> : null}
              {searchState.phase === 'error' ? (
                <div className={css.marketError} role="alert" data-market-error data-error-code={searchState.failure.code}>
                  <p>{failureText(searchState.failure, t)}</p>
                  <button
                    type="button"
                    className={css.textButton}
                    data-market-retry
                    onClick={() => { runSearch(searchState.keywords, searchState.page) }}
                  >
                    {t('retry')}
                  </button>
                </div>
              ) : null}
              {searchState.phase === 'ready' && searchState.pageData.items.length === 0 ? (
                <p className={css.status} role="status" data-market-empty>{t('searchEmpty')}</p>
              ) : null}

              {ready !== undefined && ready.pageData.items.length > 0 ? (
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
                            data-row-details
                            data-detail-repository={item.repository}
                            onClick={() => { setDetailSlug(item.repository) }}
                          >
                            {t('rowDetails')}
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </div>
          </>
        ) : (
          <div className={css.marketScroll} data-market-scroll data-detail-scroll>
            <RepositoryDetailPane
              slug={detailSlug}
              state={detailState}
              installedRefs={installedRefs}
              t={t}
              onRetry={() => { setDetailTick(value => value + 1) }}
              onInstall={(choice) => { openRefInstall(detailSlug, choice) }}
            />
          </div>
        )}

        {detailSlug === null && ready !== undefined && ready.pageData.items.length > 0 ? (
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
            {totalPages > 1 ? (
              <span className={css.pageJump}>
                <input
                  className={css.pageJumpInput}
                  type="text"
                  inputMode="numeric"
                  value={jumpValue}
                  placeholder={String(ready.page)}
                  aria-label={t('jumpToLabel')}
                  data-page-input
                  onChange={(event) => { setJumpValue(event.currentTarget.value) }}
                  onKeyDown={onJumpKey}
                />
                <button
                  type="button"
                  className={css.textButton}
                  data-page-go
                  disabled={searchState.phase === 'loading'}
                  onClick={commitJump}
                >
                  {t('jumpGo')}
                </button>
              </span>
            ) : null}
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
        ) : null}

        {installTarget !== null ? (
          <InstallDialog
            key={`${installTarget.repository}@${installTarget.refKind}:${installTarget.version}`}
            repository={installTarget.repository}
            version={installTarget.version}
            refKind={installTarget.refKind}
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
    search, repositoryDetail, previewInstall, install, t,
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

  /** Kind-aware installed-ref markers per repository, for the detail view.
   *  V2 records tag their ref with a kind (a same-name branch and tag never
   *  cross-mark); legacy records without ref metadata fall back to matching
   *  the ref name alone. Records with `source.version === null`
   *  (default-branch installs) contribute nothing: their exact ref is unknown,
   *  so no detail entry is ever wrongly marked as installed for them. */
  const installedRefs = useMemo<InstalledRefsByRepository>(() => {
    const mutable = new Map<string, { legacy: Set<string>; byKind: Record<RefKind, Set<string>> }>()
    if (listState.status !== 'ready') return new Map<string, InstalledRefs>()
    for (const view of listState.snapshot.entries) {
      const source = view.record.source
      if (source.kind !== 'github' || source.version === null) continue
      let refs = mutable.get(source.repository)
      if (refs === undefined) {
        refs = { legacy: new Set(), byKind: { branch: new Set(), tag: new Set() } }
        mutable.set(source.repository, refs)
      }
      if (source.refKind === undefined) refs.legacy.add(source.version)
      else refs.byKind[source.refKind].add(source.version)
    }
    const result = new Map<string, InstalledRefs>()
    for (const [repository, refs] of mutable) {
      result.set(repository, {
        legacy: refs.legacy,
        byKind: { branch: refs.byKind.branch, tag: refs.byKind.tag },
      })
    }
    return result
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
          installedRefs={installedRefs}
          search={search}
          repositoryDetail={repositoryDetail}
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

