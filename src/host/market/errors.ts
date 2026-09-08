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
    'The plugin records file is corrupted. It was left untouched; fix or remove it manually so it can be re-initialized.',
  'record/io': 'An I/O error occurred while reading or writing the plugin records file.',
  'record/invalid': 'The plugin record carries an invalid field value.',
  'harness/resolve-failed':
    'A shared harness package could not be resolved in the running dsh instance.',
  'harness/link-conflict':
    'A conflicting file already occupies a shared harness link path.',
  'harness/io': 'An I/O error occurred while preparing the shared harness links.',
  'github/auth':
    'The GitHub request was rejected for missing or invalid credentials.',
  'github/rate-limit':
    'The GitHub API rate limit was exceeded. Retry later or configure a token.',
  'github/network':
    'The GitHub request failed at the network level. Check connectivity and retry.',
  'github/not-found':
    'The GitHub repository or resource was not found.',
  'github/bad-response':
    'The GitHub response could not be understood.',
  'github/bad-request':
    'The requested GitHub resource is invalid.',
  'install/dir-exists':
    'A directory already occupies the install target and is not a managed checkout.',
  'install/dir-in-use':
    'The install target directory is already used by another managed plugin.',
  'install/entry-missing':
    'The resolved plugin entry file does not exist inside the checkout.',
  'install/package-invalid':
    'The checkout package.json could not be read or parsed.',
  'install/git-failed':
    'The git clone or checkout step failed.',
  'install/deps-failed':
    'Installing the checkout dependencies failed.',
  'install/io': 'An I/O error occurred during the plugin install.',
  'gate/consent-required':
    'Installing a plugin requires explicit TrustGate confirmation.',
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
