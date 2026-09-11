/**
 * 离朱独立验证（round 7：通道层与装配层的 wire 契约）
 *
 * 与组件规格互补的另一半：这里不渲染 UI，直接把 fetch 换成一个记录请求的假通道，
 * 验证
 *  1) 三个令牌方法走 POST /api/plugins-market 信封，args 固定为 {} / { value }；
 *  2) saveGitHubToken 的值原样透传（''、null、数字都不做 String 强制转换）；
 *  3) search / repositoryDetail 仅在 refresh === true 时序列化 refresh 键，
 *     默认请求体逐字节与旧版一致；
 *  4) 非 2xx 与非 JSON 答复都收敛为 market/unreachable；
 *  5) 装配期（apply + 注册 settings.section 前后）一次 fetch 都不发；
 *  6) face 恰好 16 个闭包，search 固定 perPage = SEARCH_PAGE_SIZE。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MARKET_CONTROL_WEB_PATH,
  clearGitHubToken,
  repositoryDetail,
  saveGitHubToken,
  search,
  tokenStatus,
} from '../src/client/channel.ts'
import { apply, inject, NS } from '../src/client/index.ts'
import { SEARCH_PAGE_SIZE } from '../src/client/ManagePluginsTab.tsx'
import {
  FakeLocaleRuntime,
  FakeSlotRegistry,
  makeRepositoryDetail,
  makeSearchPage,
  makeTokenStatus,
  resolveSlotLabel,
  type FakeStoredEntry,
} from './support/client-platform.ts'

const contexts: Context[] = []
const registries: FakeSlotRegistry[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.disposeInjections()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

/** One recorded channel request. */
interface Recorded {
  url: string
  method: string
  contentType: string | null
  body: { method: string; args: Record<string, unknown> }
}

/** Install a recording fetch stub; every call answers `value`. */
function stubChannel(value: unknown): { calls: Recorded[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: Recorded[] = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(url),
      method: String(init.method),
      contentType: headers['content-type'] ?? null,
      body: JSON.parse(String(init.body)) as { method: string; args: Record<string, unknown> },
    })
    return new Response(JSON.stringify({ ok: true, value }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

/** Bench: one Cordis context with the UI contribution applied. */
async function bench(): Promise<{ slots: FakeSlotRegistry; locale: FakeLocaleRuntime }> {
  const ctx = new Context()
  contexts.push(ctx)
  const locale = new FakeLocaleRuntime()
  const slots = new FakeSlotRegistry()
  registries.push(slots)
  ctx.provide('locale', locale)
  ctx.provide('slots', slots)
  await ctx.plugin({ name: 'plugin-market-ui', inject, apply }).await()
  return { slots, locale }
}

function declareSection(slots: FakeSlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  }, () => null)
}

type Face = {
  status: () => Promise<unknown>
  list: () => Promise<unknown>
  setEnabled: (key: string, enabled: boolean) => Promise<unknown>
  setClassification: (key: string, classification: string) => Promise<unknown>
  requestRemove: (key: string) => Promise<unknown>
  confirmRemove: (key: string, token: string) => Promise<unknown>
  search: (keywords: string, page: number, refresh?: boolean) => Promise<unknown>
  repositoryDetail: (repository: string, refresh?: boolean) => Promise<unknown>
  previewInstall: (repository: string, version?: string | null, refKind?: 'branch' | 'tag') => Promise<unknown>
  prepareDownload: (repository: string, confirmToken: string, version?: string | null, refKind?: 'branch' | 'tag') => Promise<unknown>
  classifyDownload: (token: string) => Promise<unknown>
  commitDownload: (token: string, classification: string) => Promise<unknown>
  cancelDownload: (token: string) => Promise<unknown>
  tokenStatus: () => Promise<unknown>
  saveToken: (value: string | null) => Promise<unknown>
  clearToken: () => Promise<unknown>
}

function faceOf(entry: FakeStoredEntry): Face {
  return (entry.inject as () => Face)()
}

function sectionEntry(slots: FakeSlotRegistry): FakeStoredEntry {
  const entry = slots.entries('settings.section')[0]
  if (entry === undefined) throw new Error('no settings.section entry')
  return entry
}

describe('[离朱] 令牌通道方法 POST 契约', () => {
  it('tokenStatus / clearGitHubToken 的 args 为空对象，saveGitHubToken 只带 value', async () => {
    const { calls } = stubChannel(makeTokenStatus({ configured: true, source: 'file' }))

    await tokenStatus()
    await saveGitHubToken('ghp_value')
    await clearGitHubToken()

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.url).toBe(MARKET_CONTROL_WEB_PATH)
      expect(call.method).toBe('POST')
      expect(call.contentType).toBe('application/json')
    }
    expect(calls[0]!.body).toEqual({ method: 'tokenStatus', args: {} })
    expect(calls[1]!.body).toEqual({ method: 'saveGitHubToken', args: { value: 'ghp_value' } })
    expect(calls[2]!.body).toEqual({ method: 'clearGitHubToken', args: {} })
  })

  it('令牌值原样透传：空串、null 与数字都不被 String 强制转换', async () => {
    const { calls } = stubChannel({ status: makeTokenStatus({ configured: false }), cacheCleared: true })

    await saveGitHubToken('')
    await saveGitHubToken(null)
    await saveGitHubToken(0 as unknown as string)
    await saveGitHubToken(false as unknown as string)

    // JSON 序列化后逐字节比对：value 键始终存在且保留调用方给的值/类型。
    expect(calls.map(call => JSON.stringify(call.body))).toEqual([
      '{"method":"saveGitHubToken","args":{"value":""}}',
      '{"method":"saveGitHubToken","args":{"value":null}}',
      '{"method":"saveGitHubToken","args":{"value":0}}',
      '{"method":"saveGitHubToken","args":{"value":false}}',
    ])
  })
})
describe('[离朱] refresh 仅在显式 true 时上线', () => {
  it('search 默认请求体逐字节等于旧版（无 refresh 键）', async () => {
    const { calls } = stubChannel(makeSearchPage([]))
    await search('agents', 10, 2)
    expect(JSON.stringify(calls[0]!.body))
      .toBe('{"method":"search","args":{"keywords":"agents","perPage":10,"page":2}}')
  })

  it('search 的 refresh 只在 === true 时序列化，false / undefined 都不产生该键', async () => {
    const { calls } = stubChannel(makeSearchPage([]))
    await search('agents', 10, 2, true)
    await search('agents', 10, 2, false)
    await search('agents', 10, 2, undefined)
    // 形如真值的字符串同样不上线（严格 === true 判定）。
    await search('agents', 10, 2, 'true' as unknown as boolean)

    expect(JSON.stringify(calls[0]!.body))
      .toBe('{"method":"search","args":{"keywords":"agents","perPage":10,"page":2,"refresh":true}}')
    for (const call of calls.slice(1)) {
      expect(JSON.stringify(call.body)).toBe('{"method":"search","args":{"keywords":"agents","perPage":10,"page":2}}')
    }
  })

  it('search 省略 perPage/page 时也不上线空键', async () => {
    const { calls } = stubChannel(makeSearchPage([]))
    await search(null)
    expect(calls[0]!.body).toEqual({ method: 'search', args: {} })
    await search('', undefined, undefined, true)
    expect(calls[1]!.body).toEqual({ method: 'search', args: { keywords: '', refresh: true } })
  })

  it('repositoryDetail 默认不带 refresh，true 时带 refresh: true', async () => {
    const { calls } = stubChannel(makeRepositoryDetail({ repository: 'octocat/demo' }))
    await repositoryDetail('octocat/demo')
    await repositoryDetail('octocat/demo', true)
    await repositoryDetail('octocat/demo', false)

    expect(JSON.stringify(calls[0]!.body)).toBe('{"method":"repositoryDetail","args":{"repository":"octocat/demo"}}')
    expect(JSON.stringify(calls[1]!.body))
      .toBe('{"method":"repositoryDetail","args":{"repository":"octocat/demo","refresh":true}}')
    expect(JSON.stringify(calls[2]!.body)).toBe('{"method":"repositoryDetail","args":{"repository":"octocat/demo"}}')
  })
})

describe('[离朱] 答复与传输失败的处理', () => {
  it('ok:false 信封原样透出 code / message / details，不抛异常', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'github/bad-request', message: 'empty token', details: { field: 'value' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const result = await saveGitHubToken('')
    expect(result).toEqual({
      ok: false,
      error: { code: 'github/bad-request', message: 'empty token', details: { field: 'value' } },
    })
  })

  it('非 2xx（例如路由只允许 POST 时的 405）与非 JSON 答复都收敛为 market/unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Method Not Allowed', { status: 405 })))
    const rejected = await tokenStatus()
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('market/unreachable')
      expect(rejected.error.message).toContain('405')
    }

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>proxy</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))
    const html = await clearGitHubToken()
    expect(html.ok).toBe(false)
    if (!html.ok) expect(html.error.code).toBe('market/unreachable')
  })

  it('传输异常（fetch 抛错）同样收敛为 market/unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    const result = await search('agents', 10, 1)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('market/unreachable')
      expect(result.error.message).toContain('network down')
    }
  })
})

describe('[离朱] 装配：apply 期不触碰 wire，face 恰好 16 个闭包', () => {
  it('注册前后零 fetch，注册后 face 的每个成员都是函数且数量为 16', async () => {
    const { slots } = await bench()
    const { fetchMock } = stubChannel(makeSearchPage([]))

    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()

    const stop = declareSection(slots)
    const entry = sectionEntry(slots)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBeTruthy()

    const face = faceOf(entry)
    const members = Object.keys(face).sort()
    expect(members).toHaveLength(16)
    expect(members).toEqual([
      'cancelDownload', 'classifyDownload', 'clearToken', 'commitDownload',
      'confirmRemove', 'list', 'prepareDownload', 'previewInstall',
      'repositoryDetail', 'requestRemove', 'saveToken', 'search',
      'setClassification', 'setEnabled', 'status', 'tokenStatus',
    ])
    for (const member of members) {
      expect(typeof (face as unknown as Record<string, unknown>)[member], member).toBe('function')
    }
    expect(fetchMock).not.toHaveBeenCalled()

    stop()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })

  it('face.search 固定 perPage = SEARCH_PAGE_SIZE 并透传 refresh；saveToken/clearToken 映射到令牌通道', async () => {
    const { slots } = await bench()
    const { calls } = stubChannel(makeSearchPage([]))
    declareSection(slots)
    const face = faceOf(sectionEntry(slots))

    await face.search('agents', 3)
    await face.search('agents', 3, true)
    await face.repositoryDetail('octocat/demo', true)
    await face.saveToken('ghp_secret')
    await face.clearToken()
    await face.tokenStatus()

    expect(SEARCH_PAGE_SIZE).toBe(10)
    expect(calls[0]!.body).toEqual({
      method: 'search',
      args: { keywords: 'agents', perPage: SEARCH_PAGE_SIZE, page: 3 },
    })
    expect(calls[1]!.body).toEqual({
      method: 'search',
      args: { keywords: 'agents', perPage: SEARCH_PAGE_SIZE, page: 3, refresh: true },
    })
    expect(calls[2]!.body).toEqual({
      method: 'repositoryDetail',
      args: { repository: 'octocat/demo', refresh: true },
    })
    expect(calls[3]!.body).toEqual({ method: 'saveGitHubToken', args: { value: 'ghp_secret' } })
    expect(calls[4]!.body).toEqual({ method: 'clearGitHubToken', args: {} })
    expect(calls[5]!.body).toEqual({ method: 'tokenStatus', args: {} })
  })
})