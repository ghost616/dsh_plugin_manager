/**
 * 组合器集成用例（单行收敛）：在组合器 ctx 内激活控制逻辑。
 * 以真 Cordis Context + 真 Loader + 仓库服务（MarketRepositoryService）复现
 * 包主入口的动作 —— ctx.plugin(marketControlPlugin) —— 并验证
 * marketRepository/loader 从同一 ctx 链解析、按记录 rebuild、listManaged/
 * setEnabled 走通、webServer 出现后注册通道。
 *
 * marketControlPlugin 含标准 decorator 依赖链，vitest/oxc 无法为 Node 25
 * 降级，故此处消费 tsc 产物 lib/types/host/control/index.js（pnpm test 前置
 * tsc -b；见 control-gateway.spec.ts 头注）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PluginRecordStore } from '../src/host/market/records.ts'
import { MarketRepositoryService } from '../src/host/market/service.ts'
import type { MarketRepository } from '../src/host/market/index.ts'
// @ts-expect-error -- compiled artifact (see header note)
import { default as marketControlPlugin } from '../lib/types/host/control/index.js'
import { key, demoPluginSource, DEMO_LOG_KEY } from './support/control-testbed.ts'

const contexts: Context[] = []
const scratchRoots: string[] = []

beforeEach(() => {
  ;(globalThis as Record<symbol, unknown>)[DEMO_LOG_KEY] = []
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  delete (globalThis as Record<symbol, unknown>)[DEMO_LOG_KEY]
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function until(
  description: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function openRepository(root: string, store: PluginRecordStore): MarketRepository {
  return {
    root,
    records: store,
    harnessLinks: { scopePath: join(root, 'node_modules', '@deepseek-ai'), links: [] },
    harnessVerified: null,
  }
}

describe('composer-ctx activation of the market control (单行收敛)', () => {
  it('resolves services on one context chain, rebuilds, serves list/setEnabled, and mounts the web route when webServer appears', async () => {
    const repoRoot = join('tests', '.tmp', `composer-${randomUUID()}`)
    const checkout = join(repoRoot, 'gh-beta')
    mkdirSync(checkout, { recursive: true })
    scratchRoots.push(repoRoot)
    writeFileSync(join(checkout, 'plugin.mjs'), demoPluginSource('composer-demo-plugin', '@deepseek-ai/cordis'), 'utf8')

    const store = new PluginRecordStore(join(repoRoot, 'plugins.json'))
    await store.load()
    await store.add({
      key: key('gh-alpha'),
      source: { kind: 'github', repository: 'demo/alpha', version: null, commit: null },
      localDirName: 'gh-alpha',
      entry: 'index.mjs',
    })
    const beta = await store.add({
      key: key('gh-beta'),
      source: { kind: 'github', repository: 'demo/beta', version: 'v1.0.0', commit: null },
      localDirName: 'gh-beta',
      entry: 'plugin.mjs',
    })
    await store.setEnabled(beta.key, true)

    // 组合器 ctx：真 loader + 仓库服务 + 控制激活，全部挂在同一 ctx 链上。
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    new MarketRepositoryService(ctx, openRepository(repoRoot, store))
    await ctx.plugin(marketControlPlugin)

    const control = ctx.get('marketControl') as {
      listManaged: () => Promise<{ entries: { key: string; runtime: { phase: string | null; disabled: boolean; moduleName: string | null } }[] }>
      setEnabled: (key: string, enabled: boolean) => Promise<unknown>
    }

    // 按记录 rebuild：enabled 记录已加载（同一 ctx 链 loader 解析 + 单实例），disabled 保持停用。
    await until('rebuild shows beta active and alpha disabled', async () => {
      const list = await control.listManaged()
      const betaRow = list.entries.find(row => row.key === 'gh-beta')
      const alphaRow = list.entries.find(row => row.key === 'gh-alpha')
      return betaRow?.runtime.phase === 'active'
        && alphaRow?.runtime.disabled === true && alphaRow?.runtime.phase === null
        && list.entries.length === 2
    })
    const afterRebuild = await control.listManaged()
    const betaRow = afterRebuild.entries.find(row => row.key === 'gh-beta')
    expect(betaRow?.runtime.moduleName).toContain('plugin.mjs')
    const log = () => (globalThis as Record<symbol, { kind: string }[]>)[DEMO_LOG_KEY] as { kind: string }[]
    expect(log().filter(entry => entry.kind === 'up')).toHaveLength(1)

    // setEnabled(false) 停用：loader 行转 disabled，相位消失，记录保留。
    await control.setEnabled('gh-beta', false)
    await until('beta is disabled after setEnabled(false)', async () => {
      const betaRow2 = (await control.listManaged()).entries.find(row => row.key === 'gh-beta')
      return betaRow2?.runtime.disabled === true && betaRow2?.runtime.phase === null
    })
    expect((await store.get(beta.key))?.enabled).toBe(false)
    expect(log().filter(entry => entry.kind === 'down')).toHaveLength(1)

    // 重新启用：同一 ctx 链上的 loader 再导入（模块缓存，二次 apply）。
    await control.setEnabled('gh-beta', true)
    await until('beta active again after setEnabled(true)', async () => {
      const betaRow3 = (await control.listManaged()).entries.find(row => row.key === 'gh-beta')
      return betaRow3?.runtime.phase === 'active'
    })
    expect(log().filter(entry => entry.kind === 'up')).toHaveLength(2)

    // webServer 在同一 ctx 链出现后，控制激活注册 /api/plugins-market 通道。
    const routes: string[] = []
    ctx.provide('webServer', {
      register: (route: { kind: string; path: string; handler: unknown }) => {
        routes.push(route.path)
        return () => {
          const at = routes.indexOf(route.path)
          if (at !== -1) routes.splice(at, 1)
        }
      },
    })
    await until('web channel route is registered', () => routes.includes('/api/plugins-market'))

    // 卸载组合 ctx：控制器经其 effect 清除所属 loader 行。
    const loader = ctx.loader
    const ownIndex = contexts.indexOf(ctx)
    if (ownIndex !== -1) contexts.splice(ownIndex, 1)
    await ctx.fiber.dispose()
    await until(
      'composer teardown clears managed loader rows',
      () => ![...loader.entries()].some(entry => entry.options.name.includes('plugin.mjs')),
    )
    expect([...loader.entries()]).toHaveLength(0)
  })
})