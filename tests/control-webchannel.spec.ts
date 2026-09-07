/**
 * Web channel spec (攻关 B round trip) against the tsc-emitted gateway artifact
 * (see control-gateway.spec.ts header for why decorator sources run compiled).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
// @ts-expect-error -- compiled artifact
import { MARKET_WEB_ROUTE_PATH, registerMarketWebChannel } from '../lib/types/host/control/web-channel.js'
// @ts-expect-error -- compiled artifact
import { MarketControllerGateway } from '../lib/types/host/control/gateway.js'
import { testbed } from './support/control-testbed.ts'

const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

/** Minimal exact-route http server shaped like the dsh WebServer contract. */
class RouterServer {
  readonly server = createServer((req, res) => this.dispatch(req, res))
  private readonly exact = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()

  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void {
    if (route.kind !== 'exact' || this.exact.has(route.path)) throw new Error('duplicate route')
    this.exact.set(route.path, route.handler)
    return () => { this.exact.delete(route.path) }
  }

  get url(): string {
    const address = this.server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  private dispatch(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const handler = this.exact.get(pathname)
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.writeHead(500)
      res.end(String(error))
    })
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
}

type WireResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }

async function call(router: RouterServer, method: string, args: object): Promise<WireResult> {
  const response = await fetch(`${router.url}${MARKET_WEB_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
  expect(response.status).toBe(200)
  return await response.json() as WireResult
}

describe('market control web channel (candidate B round trip)', () => {
  it('serves listManaged / setEnabled / double-confirmed remove over HTTP', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const bed = testbed()
    const record = bed.records.seed('gh-web', { enabled: false, localDirName: 'web', entry: 'plugin.mjs' })
    const gateway = new MarketControllerGateway(ctx, bed.controller())
    const router = new RouterServer()
    servers.push(router.server)
    const disposeRoute = registerMarketWebChannel(router, gateway)
    await listen(router.server)

    const listed = await call(router, 'listManaged', {})
    expect(listed.ok).toBe(true)
    const entries = (listed as { ok: true; value: { entries: unknown[] } }).value.entries
    expect(entries).toHaveLength(1)

    const enabled = await call(router, 'setEnabled', { key: 'gh-web', enabled: true })
    expect(enabled).toMatchObject({ ok: true, value: { enabled: true } })
    expect(bed.loader.view(record.key)).toMatchObject({ disabled: false, phase: 'active' })

    // Step 1: a bare remove request is refused (double confirmation).
    const bareRemove = await call(router, 'confirmRemove', { key: 'gh-web', token: 'x' })
    expect(bareRemove.ok).toBe(false)
    if (!bareRemove.ok) expect(bareRemove.error.code).toBe('market/confirm-required')

    const request = await call(router, 'requestRemove', { key: 'gh-web' })
    expect(request.ok).toBe(true)
    const token = (request as { ok: true; value: { token: string } }).value.token

    const confirmed = await call(router, 'confirmRemove', { key: 'gh-web', token })
    expect(confirmed.ok).toBe(true)
    const outcome = (confirmed as { ok: true; value: { removedEntry: boolean } }).value
    expect(outcome.removedEntry).toBe(true)
    expect(bed.loader.view(record.key)).toBeUndefined()
    expect(await bed.records.get(record.key)).toBeNull()
    expect(bed.remover.removed).toEqual(['/repo/web'])

    disposeRoute()
  })

  it('rejects wrong method, unknown method, and malformed JSON', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const gateway = new MarketControllerGateway(ctx, testbed().controller())
    const router = new RouterServer()
    servers.push(router.server)
    const disposeRoute = registerMarketWebChannel(router, gateway)
    await listen(router.server)

    const get = await fetch(`${router.url}${MARKET_WEB_ROUTE_PATH}`, { method: 'GET' })
    expect(get.status).toBe(405)
    expect((await get.json() as WireResult).ok).toBe(false)

    const unknown = await fetch(`${router.url}${MARKET_WEB_ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'deleteEverything', args: {} }),
    })
    expect(unknown.status).toBe(400)
    expect((await unknown.json() as WireResult).ok).toBe(false)

    const malformed = await fetch(`${router.url}${MARKET_WEB_ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(malformed.status).toBe(400)
    expect((await malformed.json() as WireResult).ok).toBe(false)

    disposeRoute()
  })
})