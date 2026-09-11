/**
 * External Host→Client web channel (candidate B): one exact
 * `ctx.webServer` route carrying a JSON envelope shaped like the Remote
 * result contract, so a same-origin browser half (or any HTTP client) can
 * drive the market control service without generated Typert artifacts.
 *
 * Wire shape:
 *   POST /api/plugins-market
 *   { "method": "status" | "listManaged" | "setEnabled" | "setClassification"
 *       | "requestRemove" | "confirmRemove" | "search" | "repositoryDetail"
 *       | "previewInstall" | "prepareDownload" | "classifyDownload"
 *       | "commitDownload" | "cancelDownload"
 *       | "tokenStatus" | "saveGitHubToken" | "clearGitHubToken",
 *     "args": { ... } }
 *   200 → { "ok": true, "value": ... }
 *        | { "ok": false, "error": { "code", "message", "details" } }
 *   Non-POST → 405, malformed body / unknown method / bad args → 400 (same
 *   envelope).
 *
 * The envelope mirrors the native Remote result so consumers branch on
 * `ok`/`error.code` exactly as they would on the Remote carrier.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {
  GitHubSearchPage,
  GitHubTokenStatus,
  GitHubTokenUpdateResult,
  ManagedPluginList,
  MarketStatus,
  PluginInstallReview,
  PluginMarketRecord,
  RemoveOutcome,
  RemoveRequest,
  RepositoryDetail,
} from '../../types.ts'
import type {
  DownloadClassification,
  DownloadCommit,
  DownloadPreparation,
} from './source.ts'
import type { MarketControllerGateway } from './gateway.ts'
import { toRemoteError } from './gateway.ts'

/** Exact route path of the market control web channel. */
export const MARKET_WEB_ROUTE_PATH = '/api/plugins-market'

/** Request body cap (64 KiB) — far beyond any method payload. */
export const MARKET_WEB_MAX_BODY_BYTES = 64 * 1024

/** Minimal shape of the `ctx.webServer.register` contract we consume. */
export interface MarketWebRouter {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

// The shipped host webserver package declares this key; our single-package
// Program types the narrow surface we actually consume.
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: MarketWebRouter
  }
}

/** One server-side method: required/optional wire parameters and the call. */
interface MethodMeta {
  readonly parameters: readonly string[]
  readonly optional?: readonly string[]
  readonly call: (gateway: MarketControllerGateway, args: Record<string, unknown>) => Promise<unknown>
}

const METHODS: Record<string, MethodMeta> = {
  status: {
    parameters: [],
    call: (gateway) => gateway.status(),
  },
  listManaged: {
    parameters: [],
    call: (gateway) => gateway.listManaged(),
  },
  setEnabled: {
    parameters: ['key', 'enabled'],
    call: (gateway, args) => gateway.setEnabled(String(args.key), Boolean(args.enabled)),
  },
  requestRemove: {
    parameters: ['key'],
    call: (gateway, args) => gateway.requestRemove(String(args.key)),
  },
  confirmRemove: {
    parameters: ['key', 'token'],
    call: (gateway, args) => gateway.confirmRemove(String(args.key), String(args.token)),
  },
  search: {
    parameters: [],
    optional: ['keywords', 'perPage', 'page', 'refresh'],
    call: (gateway, args) => {
      const keywords = optionalString(args.keywords)
      const perPage = optionalNumber(args.perPage)
      const page = optionalNumber(args.page)
      const refresh = optionalBoolean(args.refresh)
      return gateway.search(
        keywords,
        perPage,
        page,
        refresh === null ? undefined : { refresh },
      )
    },
  },
  repositoryDetail: {
    parameters: ['repository'],
    optional: ['refresh'],
    call: (gateway, args) => {
      const refresh = optionalBoolean(args.refresh)
      return gateway.repositoryDetail(
        String(args.repository),
        refresh === null ? undefined : { refresh },
      )
    },
  },
  tokenStatus: {
    parameters: [],
    call: (gateway) => gateway.tokenStatus(),
  },
  saveGitHubToken: {
    parameters: ['value'],
    // NOT `String(args.value)`: an unconditional coercion would turn `null`
    // into the literal token "null" (and an object into "[object Object]"), so
    // a single malformed request would leave the deployment "configured" with a
    // bogus bearer header while the port's non-empty-string guard looked intact.
    // Every no-value form (missing key included) is answered by the port's one
    // stable `github/bad-request` with zero side effects — see `requiredToken`.
    call: (gateway, args) => gateway.saveGitHubToken(requiredToken(args.value)),
  },
  clearGitHubToken: {
    parameters: [],
    call: (gateway) => gateway.clearGitHubToken(),
  },
  previewInstall: {
    parameters: ['repository'],
    optional: ['refKind', 'version'],
    call: (gateway, args) => gateway.previewInstall(
      String(args.repository),
      optionalRefKind(args.refKind),
      optionalVersion(args.version),
    ),
  },
  prepareDownload: {
    parameters: ['repository', 'confirmToken'],
    optional: ['refKind', 'version'],
    call: (gateway, args) => gateway.prepareDownload(
      String(args.repository),
      String(args.confirmToken),
      optionalRefKind(args.refKind),
      optionalVersion(args.version),
    ),
  },
  classifyDownload: {
    parameters: ['token'],
    call: (gateway, args) => gateway.classifyDownload(String(args.token)),
  },
  commitDownload: {
    parameters: ['token', 'classification'],
    call: (gateway, args) => gateway.commitDownload(String(args.token), String(args.classification)),
  },
  cancelDownload: {
    parameters: ['token'],
    call: (gateway, args) => gateway.cancelDownload(String(args.token)),
  },
  setClassification: {
    parameters: ['key', 'classification'],
    call: (gateway, args) => gateway.setClassification(String(args.key), String(args.classification)),
  },
}

/** Transport-level refusal (bad method/body/method name/arguments). */
class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'market/bad-request',
    readonly details: object = {},
  ) {
    super(message)
    this.name = 'HttpRefusal'
  }
}

/** Register the channel on a webServer-shaped router; returns the disposer. */
export function registerMarketWebChannel(
  router: MarketWebRouter,
  gateway: MarketControllerGateway,
): () => void {
  return router.register({
    kind: 'exact',
    path: MARKET_WEB_ROUTE_PATH,
    handler: (req, res) => void handleRequest(req, res, gateway),
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  gateway: MarketControllerGateway,
): Promise<void> {
  try {
    if (req.method !== 'POST') {
      throw new HttpRefusal(405, 'Only POST is accepted by the market control channel.')
    }
    let payload: unknown
    try {
      payload = JSON.parse(await readBody(req)) as unknown
    } catch (error) {
      if (error instanceof HttpRefusal) throw error
      throw new HttpRefusal(400, 'The market control request is not valid JSON.')
    }
    const value = await dispatch(payload, gateway)
    send(res, 200, { ok: true, value })
  } catch (error) {
    if (error instanceof HttpRefusal) {
      send(res, error.status, {
        ok: false,
        error: { code: error.code, message: error.message, details: error.details },
      })
      return
    }
    send(res, 200, failResult(error))
  }
}

async function dispatch(payload: unknown, gateway: MarketControllerGateway): Promise<unknown> {
  if (!isRecord(payload)) {
    throw new HttpRefusal(400, 'The request body must be a JSON object with "method" and "args".')
  }
  const method = payload.method
  if (typeof method !== 'string') {
    throw new HttpRefusal(400, 'The request body is missing a string "method".')
  }
  const meta = METHODS[method]
  if (meta === undefined) {
    throw new HttpRefusal(400, `Unknown market control method ${JSON.stringify(method)}.`)
  }
  const rawArgs = payload.args
  if (!isRecord(rawArgs)) {
    throw new HttpRefusal(400, 'The request body "args" must be a JSON object.')
  }
  const args: Record<string, unknown> = {}
  for (const name of meta.parameters) {
    if (!Object.hasOwn(rawArgs, name)) {
      throw new HttpRefusal(
        400,
        `The market control method ${JSON.stringify(method)} is missing argument ${JSON.stringify(name)}.`,
      )
    }
    args[name] = rawArgs[name]
  }
  for (const name of meta.optional ?? []) {
    if (Object.hasOwn(rawArgs, name)) args[name] = rawArgs[name]
  }
  return meta.call(gateway, args)
}

function failResult(error: unknown) {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) {
    return {
      ok: false as const,
      error: { code: remote.code, message: remote.message, details: remote.details },
    }
  }
  const normalized = toRemoteError(error)
  return {
    ok: false as const,
    error: { code: normalized.code, message: normalized.message, details: normalized.details },
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk)
      if (size > MARKET_WEB_MAX_BODY_BYTES) {
        reject(new HttpRefusal(400, 'The market control request body exceeds the size limit.'))
        req.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new HttpRefusal(400, 'The argument must be a string.')
  return value
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HttpRefusal(400, 'The argument must be a positive integer.')
  }
  return value
}

function optionalVersion(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new HttpRefusal(400, 'The "version" argument must be a string or null.')
  return value
}

/**
 * Token argument of `saveGitHubToken`: only a real string is handed to the
 * port, every other shape is answered as "no usable value" (null).
 *
 * NOT `String(args.value)`: an unconditional coercion turned `null` into the
 * literal token "null" (an object into "[object Object]", an array into its
 * first element), so one malformed request left the deployment "configured"
 * with a bogus bearer header while the port's non-empty-string guard looked
 * intact. Passing null instead keeps ONE stable answer for every no-value form
 * (`github/bad-request`, zero side effects, no cache-clear report) and leaves
 * the port as the single place that decides about token values. A missing key
 * is still a transport-level 400 — it is a malformed request, not a value.
 */
function requiredToken(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Optional boolean flag (the explicit-refresh arguments). `null` means "not
 * given" — the caller then keeps the cached default behavior rather than
 * sending an explicit `false`.
 */
function optionalBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw new HttpRefusal(400, 'The argument must be a boolean or null.')
  return value
}

function optionalRefKind(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (value !== 'branch' && value !== 'tag') {
    throw new HttpRefusal(400, 'The "refKind" argument must be "branch", "tag" or null.')
  }
  return value
}

/** Value exports of the channel, typed for future consumers. */
export type MarketChannelValue =
  | MarketStatus
  | ManagedPluginList
  | PluginMarketRecord
  | RemoveRequest
  | RemoveOutcome
  | GitHubSearchPage
  | PluginInstallReview
  | DownloadPreparation
  | DownloadClassification
  | DownloadCommit
  | GitHubTokenStatus
  | GitHubTokenUpdateResult
  | boolean
  | RepositoryDetail
