import type { PluginMarketErrorCode } from '../../types.ts'

/** Operator-facing default message per stable code, kept next to the code. */
const DEFAULT_MESSAGE: Record<PluginMarketErrorCode, string> = {
  'config/invalid': 'Invalid plugin-market configuration.',
  'repository/not-exist':
    'The plugin source repository does not exist. Create the directory or point the plugin-market Config at an existing one.',
  'repository/not-directory':
    'The plugin source repository path is not a directory. Choose an existing directory.',
  'repository/not-writable':
    'The plugin source repository is not writable. Grant write permission (including file creation) and retry.',
  'repository/io':
    'An I/O error occurred while accessing the plugin source repository.',
  'record/key-invalid': 'Invalid plugin record key.',
  'record/exists': 'A plugin with this key is already recorded.',
  'record/not-found': 'No plugin record exists for the requested key.',
  'record/corrupt':
    'The plugin records file is corrupted. It was left untouched — fix or remove it manually so it can be re-initialized.',
  'record/io': 'An I/O error occurred while reading or writing the plugin records file.',
  'harness/resolve-failed':
    'A shared harness package could not be resolved in the running dsh instance.',
  'harness/link-conflict':
    'A conflicting file already occupies a shared harness link path.',
  'harness/io': 'An I/O error occurred while preparing the shared harness links.',
}

/** Optional context attached to a {@link MarketError}. */
export interface MarketErrorOptions {
  /** Path the failure is about, when there is one. */
  path?: string
  /** Underlying cause, appended for observability. */
  cause?: unknown
}

/**
 * Typed failure of the plugin-market repository layer. Carries the stable
 * {@link PluginMarketErrorCode} vocabulary (the same codes future Remote/wire
 * boundaries reuse) plus the offending path and a human-readable message.
 */
export class MarketError extends Error {
  constructor(
    readonly code: PluginMarketErrorCode,
    message?: string,
    options: MarketErrorOptions = {},
  ) {
    const pathNote = options.path ? ` Path: ${options.path}` : ''
    const causeNote = describeCause(options.cause)
    super(`${message ?? DEFAULT_MESSAGE[code]}${pathNote}${causeNote}`)
    this.name = 'MarketError'
  }
}

/** Error-builder shorthand: `marketError(code)` or with message/path. */
export function marketError(
  code: PluginMarketErrorCode,
  message?: string,
  path?: string,
): MarketError {
  return new MarketError(code, message, path === undefined ? {} : { path })
}

function describeCause(cause: unknown): string {
  if (cause === undefined || cause === null) return ''
  const text = cause instanceof Error ? cause.message : String(cause)
  return text ? ` (${text})` : ''
}
