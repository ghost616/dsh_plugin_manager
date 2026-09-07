/**
 * Narrow Loader adapter isolating the market controller from the Cordis
 * Loader tree shape. Mirrors the projection the shipped plugin inventory
 * computes (same fiber-state numbers, same "no second cache" read-through),
 * so a managed plugin's live facts always agree with `pluginInventory.list`.
 */

import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ManagedPluginPhase } from '../../types.ts'

/** Fiber-state ordinal mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

/** One non-group loader entry as the controller sees it. */
export interface LoaderEntryView {
  /** Entry id inside its tree (equals the record key for managed rows). */
  readonly id: string
  /** Exact module specifier the entry imports. */
  readonly moduleName: string
  /** Effective disablement, including disabled ancestors. */
  readonly disabled: boolean
  /** Root-fiber phase; null when the entry has no live fiber. */
  readonly phase: ManagedPluginPhase
}

/** Options accepted by {@link LoaderAdapter.create}. */
export interface LoaderCreateInput {
  /** Deterministic entry id (the loader honors a caller-supplied id). */
  readonly id: string
  /** Module specifier to import (an absolute file URL for managed plugins). */
  readonly moduleName: string
  /** Create the entry disabled without importing (true) or load it. */
  readonly disabled: boolean
}

/** Loader operations the market controller needs. */
export interface LoaderAdapter {
  /** Live non-group entries of the loader tree (including nested subtrees). */
  entries(): readonly LoaderEntryView[]
  /** Create one entry; resolves once its load (or disabled no-op) settled. */
  create(input: LoaderCreateInput): Promise<void>
  /** Update one entry (disablement toggle); resolves once the change settled. */
  update(id: string, options: { disabled?: boolean }): Promise<void>
  /** Stop and remove one entry; missing entries are a no-op. */
  remove(id: string): Promise<void>
  /** Resolve once no entry of the tree has pending load/lifecycle work. */
  idle(): Promise<void>
}

/** One loader entry id → entry snapshot for fast controller lookups. */
export type LoaderEntryMap = ReadonlyMap<string, LoaderEntryView>

/** Adapter over the real Cordis {@link Loader}. */
export function createLoaderAdapter(loader: Loader): LoaderAdapter {
  return {
    entries: () => snapshotEntries(loader),
    async create(input) {
      // The tree types omit `id` (config rows are id-less); the runtime keeps a
      // caller-supplied id — deterministic managed ids depend on it.
      await loader.create({
        id: input.id,
        name: input.moduleName,
        disabled: input.disabled,
      } as unknown as Parameters<Loader['create']>[0])
    },
    async update(id, options) {
      await loader.update(id, options as never)
    },
    async remove(id) {
      await loader.remove(id)
    },
    async idle() {
      for (;;) {
        const tasks = loader.getTasks()
        if (tasks.length === 0) return
        await Promise.allSettled(tasks)
      }
    },
  }
}

/** Read live non-group entries in loader order. */
export function snapshotEntries(loader: Loader): LoaderEntryView[] {
  const views: LoaderEntryView[] = []
  for (const entry of loader.entries()) {
    if (entry.options.group) continue
    views.push({
      id: entry.id,
      moduleName: entry.options.name,
      disabled: entry.disabled,
      phase: phaseOf(entry.fiber?.state),
    })
  }
  return views
}

/** Map loader entries by id (managed rows use the record key). */
export function indexEntries(entries: readonly LoaderEntryView[]): LoaderEntryMap {
  return new Map(entries.map(entry => [entry.id, entry]))
}

function phaseOf(state: number | undefined): ManagedPluginPhase {
  switch (state) {
    case FIBER_STATE.PENDING: return 'pending'
    case FIBER_STATE.LOADING: return 'loading'
    case FIBER_STATE.ACTIVE: return 'active'
    case FIBER_STATE.FAILED: return 'failed'
    case FIBER_STATE.UNLOADING: return 'unloading'
    default: return null
  }
}