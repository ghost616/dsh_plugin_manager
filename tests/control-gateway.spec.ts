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
import { key, testbed } from './support/control-testbed.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function harness(): { ctx: Context; gateway: MarketControllerGateway } {
  const ctx = new Context()
  contexts.push(ctx)
  const controller = testbed().controller()
  const gateway = new MarketControllerGateway(ctx, controller)
  return { ctx, gateway }
}

describe('MarketControllerGateway host Remote surface', () => {
  it('publishes the marketControl namespace with four direct methods', () => {
    const { gateway } = harness()
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: MARKET_CONTROL_SERVICE_KEY,
      namespace: MARKET_CONTROL_SERVICE_KEY,
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'listManaged', invocation: { kind: 'direct' } },
      { method: 'setEnabled', invocation: { kind: 'direct' } },
      { method: 'requestRemove', invocation: { kind: 'direct' } },
      { method: 'confirmRemove', invocation: { kind: 'direct' } },
    ])
  })

  it('registers the gateway under its service key', () => {
    const { ctx, gateway } = harness()
    // Cordis resolves service reads through a traceable wrapper, so identity
    // is asserted through the binding and surface instead of object equality.
    const resolved = ctx.get(MARKET_CONTROL_SERVICE_KEY) as {
      typertRemote?: { serviceKey?: string; namespace?: string }
      listManaged?: unknown
    }
    expect(resolved.typertRemote).toMatchObject({
      serviceKey: MARKET_CONTROL_SERVICE_KEY,
      namespace: MARKET_CONTROL_SERVICE_KEY,
    })
    expect(typeof resolved.listManaged).toBe('function')
    expect(gateway).toBeInstanceOf(MarketControllerGateway)
  })

  it('listManaged answers through the live controller', async () => {
    const { gateway } = harness()
    const result = await gateway.listManaged()
    expect(result.entries).toEqual([])
  })

  it('maps MarketControlError to a wire RemoteError with the stable code', () => {
    const error = new MarketControlError('market/confirm-expired', 'expired', { key: key('gh-x') })
    const remote = toRemoteError(error)
    expect(remote).toBeInstanceOf(RemoteError)
    expect(remoteErrorOf(remote)).toMatchObject({ code: 'market/confirm-expired', message: 'expired' })
    expect(remote.details).toEqual({ key: 'gh-x' })
  })

  it('rejects an invalid wire key with record/key-invalid', async () => {
    const { gateway } = harness()
    await expect(gateway.setEnabled('not a key', true)).rejects.toMatchObject({
      code: 'record/key-invalid',
    })
    const caught = await gateway.setEnabled('gh-nope', true).catch((error: unknown) => error)
    expect(remoteErrorOf(caught)).toMatchObject({ code: 'record/not-found' })
  })
})