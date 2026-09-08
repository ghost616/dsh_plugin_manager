/**
 * Gateway host-surface spec. The gateway source uses TC39 standard decorators;
 * the vitest/oxc pipeline of this environment cannot lower them for Node 25,
 * so this spec drives the tsc-emitted artifact (lib/types/host/control/*.js,
 * produced by `tsc -b tsconfig.json` ahead of `pnpm test`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError, remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
// @ts-expect-error -- compiled artifact (see header note)
import {
  MARKET_CONTROL_SERVICE_KEY,
  MarketControllerGateway,
  toRemoteError,
} from '../lib/types/host/control/gateway.js'
// @ts-expect-error -- compiled artifact (see header note)
import { MarketControlError } from '../lib/types/host/control/controller.js'
import {
  key,
  makeSourceOps,
  testbed,
} from './support/control-testbed.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function gatewayWith(
  options: { idle?: boolean } = {},
): { ctx: Context; gateway: MarketControllerGateway } {
  const ctx = new Context()
  contexts.push(ctx)
  const bed = testbed()
  const controller = options.idle === true ? null : bed.controller()
  const repository = options.idle === true ? null : bed.repository
  const source = makeSourceOps(repository, bed.records)
  const gateway = new MarketControllerGateway(ctx, {
    controller: () => controller,
    repository: () => repository,
    source,
  })
  return { ctx, gateway }
}

describe('MarketControllerGateway host Remote surface', () => {
  it('publishes the marketControl namespace with eight direct methods', () => {
    const { gateway } = gatewayWith()
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: MARKET_CONTROL_SERVICE_KEY,
      namespace: MARKET_CONTROL_SERVICE_KEY,
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'listManaged', invocation: { kind: 'direct' } },
      { method: 'setEnabled', invocation: { kind: 'direct' } },
      { method: 'requestRemove', invocation: { kind: 'direct' } },
      { method: 'confirmRemove', invocation: { kind: 'direct' } },
      { method: 'search', invocation: { kind: 'direct' } },
      { method: 'previewInstall', invocation: { kind: 'direct' } },
      { method: 'install', invocation: { kind: 'direct' } },
    ])
  })

  it('registers the gateway under its service key', () => {
    const { ctx, gateway } = gatewayWith()
    // Cordis resolves service reads through a traceable wrapper, so identity
    // is asserted through the binding and surface instead of object equality.
    const resolved = ctx.get(MARKET_CONTROL_SERVICE_KEY) as {
      typertRemote?: { serviceKey?: string; namespace?: string }
      listManaged?: unknown
      search?: unknown
    }
    expect(resolved.typertRemote).toMatchObject({
      serviceKey: MARKET_CONTROL_SERVICE_KEY,
      namespace: MARKET_CONTROL_SERVICE_KEY,
    })
    expect(typeof resolved.listManaged).toBe('function')
    expect(typeof resolved.search).toBe('function')
    expect(gateway).toBeInstanceOf(MarketControllerGateway)
  })

  it('listManaged answers through the live controller', async () => {
    const { gateway } = gatewayWith()
    const result = await gateway.listManaged()
    expect(result.entries).toEqual([])
  })

  it('reports configured status with the repository root', async () => {
    const { gateway } = gatewayWith()
    await expect(gateway.status()).resolves.toEqual({ configured: true, repositoryPath: '/repo' })
  })

  it('reports idle status without throwing while no repository is configured', async () => {
    const { gateway } = gatewayWith({ idle: true })
    await expect(gateway.status()).resolves.toEqual({ configured: false, repositoryPath: null })
  })

  it('answers market/idle for every operation while no repository is configured', async () => {
    const { gateway } = gatewayWith({ idle: true })
    const idle = await gateway.listManaged().catch((error: unknown) => error)
    expect(remoteErrorOf(idle)).toMatchObject({ code: 'market/idle' })
    const idleSearch = await gateway.search('demo', null).catch((error: unknown) => error)
    expect(remoteErrorOf(idleSearch)).toMatchObject({ code: 'market/idle' })
    const idleInstall = await gateway.install('octocat/demo', 'tok', null).catch((error: unknown) => error)
    expect(remoteErrorOf(idleInstall)).toMatchObject({ code: 'market/idle' })
  })

  it('delegates search to the source engine', async () => {
    const { gateway } = gatewayWith()
    const page = await gateway.search('agents', 5)
    expect(page.totalCount).toBe(0)
    expect(page.items).toEqual([])
  })

  it('maps MarketControlError to a wire RemoteError with the stable code', () => {
    const error = new MarketControlError('market/confirm-expired', 'expired', { key: key('gh-x') })
    const remote = toRemoteError(error)
    expect(remote).toBeInstanceOf(RemoteError)
    expect(remoteErrorOf(remote)).toMatchObject({ code: 'market/confirm-expired', message: 'expired' })
    expect(remote.details).toEqual({ key: 'gh-x' })
  })

  it('rejects an invalid wire key with record/key-invalid', async () => {
    const { gateway } = gatewayWith()
    await expect(gateway.setEnabled('not a key', true)).rejects.toMatchObject({
      code: 'record/key-invalid',
    })
    const caught = await gateway.setEnabled('gh-nope', true).catch((error: unknown) => error)
    expect(remoteErrorOf(caught)).toMatchObject({ code: 'record/not-found' })
  })
})