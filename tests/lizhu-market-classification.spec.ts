/**
 * 离朱独立验证用例：分类标签（classification）1/3 —— plugin-market-host。
 *
 * 对既有 market-records / market-analyze / market-install / control-analysis
 * 用例做补充与挑战，覆盖测试说明中列出的边界。本文件为纯新增用例。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_PLUGIN_MARKET_CLASSIFICATION,
  isPluginMarketClassification,
  type PluginMarketClassification,
  type PluginMarketKey,
  type PluginMarketSource,
} from '../src/types.ts'
import { MarketError } from '../src/host/market/errors.ts'
import { PluginRecordStore } from '../src/host/market/records.ts'
import { repositoryRecordsPath } from '../src/host/market/layout.ts'
import {
  DEFAULT_CHECKOUT_ENTRY,
  PluginInstaller,
  type CommandOutcome,
  type CommandRunner,
} from '../src/host/market/install.ts'
import {
  InstallAnalyzer,
  probeCheckoutEntry,
  resolveAnalysisDistribution,
  resolveAnalysisVerdict,
  type CheckoutSnapshot,
  type RawCheckoutAnalysis,
} from '../src/host/market/analyze.ts'
import { runCheckoutAnalysis } from '../src/host/control/analysis.ts'
import { MarketPluginController } from '../src/host/control/controller.ts'
import { type LoaderAdapter, type LoaderEntryView } from '../src/host/control/loader-adapter.ts'
import { entryModuleName, resolveEntryPath } from '../src/host/control/entry-name.ts'
import { isProtectedRecordKey } from '../src/host/control/protect.ts'
import { makeSuiteTmp, removeTmp } from './support/tmpdir.ts'

const githubSource: PluginMarketSource = {
  kind: 'github',
  repository: 'owner/sample-plugin',
  version: null,
  commit: null,
}

function key(value: string): PluginMarketKey {
  return value as PluginMarketKey
}

/** 断言 promise 以指定 MarketError code 失败。 */
async function rejectCode(promise: Promise<unknown>, code: string): Promise<MarketError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    const market = error as MarketError
    expect(market.code).toBe(code)
    return market
  }
  throw new Error(`expected MarketError with code ${code}, but the promise resolved`)
}

/** plugins.json 中一条合法记录的骨架。 */
function recordBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    key: 'gh-bad',
    source: { kind: 'github', repository: 'owner/bad', version: null, commit: null },
    localDirName: 'gh-bad',
    entry: null,
    installedAt: '2024-01-01T00:00:00.000Z',
    enabled: false,
    trusted: 'untrusted',
    trustedAt: null,
    ...overrides,
  }
}

/* ======================================================================== */
/* 1. 记录层：分类标签的写入与加载（文件路径 + 输入路径）                     */
/* ======================================================================== */

describe('[挑战] record classification —— 文件路径非法标签 record/corrupt 且不改文件', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-records-bad-file') })
  afterAll(async () => { await removeTmp(tmp) })

  const badValues: readonly unknown[] = ['preset', 'PLUGIN', 'Skills', '', 42, {}, [], true]

  it.each(badValues.map((value, index) => [JSON.stringify(value) ?? String(value), value, index] as const))('rejects classification %s in the file as record/corrupt and leaves the bytes untouched', async (label, value, index) => {
      const file = join(tmp, `bad-file-${index}.json`)
      await writeFile(file, JSON.stringify({
        schemaVersion: 1,
        records: { 'gh-bad': recordBody({ classification: value }) },
      }), 'utf8')
      const before = await readFile(file, 'utf8')
      const error = await rejectCode(new PluginRecordStore(file).load(), 'record/corrupt')
      expect(error.message).toContain('classification')
      expect(error.message).toContain(label)
      expect(await readFile(file, 'utf8')).toBe(before)
    },
  )

  it('accepts exactly the three persisted labels', async () => {
    for (const [index, label] of (['plugin', 'skills', 'other'] as const).entries()) {
      const file = join(tmp, `good-file-${index}.json`)
      await writeFile(file, JSON.stringify({
        schemaVersion: 1,
        records: { 'gh-bad': recordBody({ classification: label }) },
      }), 'utf8')
      expect((await new PluginRecordStore(file).load())[0]?.classification).toBe(label)
    }
  })
})

describe('[挑战] record classification —— 输入路径非法标签 record/invalid 且不污染文件', () => {
  let tmp: string
  let filePath: string
  beforeAll(async () => {
    tmp = await makeSuiteTmp('lizhu-records-bad-input')
    filePath = join(tmp, 'plugins.json')
  })
  afterAll(async () => { await removeTmp(tmp) })

  it('rejects every illegal tag through add() and register() while keeping the seeded record intact', async () => {
    const store = new PluginRecordStore(filePath)
    await store.add({ key: key('gh-seed'), source: githubSource, localDirName: 'gh-seed', classification: 'skills' })
    const seeded = await readFile(filePath, 'utf8')

    const illegal: readonly unknown[] = ['preset', 'PLUGIN', 'Skills', '', 42, {}, [], null]
    for (const value of illegal) {
      const bad = value as PluginMarketClassification
      const addError = await rejectCode(
        store.add({ key: key('gh-bad-input'), source: githubSource, localDirName: 'gh-bad-input', classification: bad }),
        'record/invalid',
      )
      expect(addError.message).toContain('classification')
      await rejectCode(
        store.register({ key: key('gh-bad-input'), source: githubSource, localDirName: 'gh-bad-input', classification: bad }),
        'record/invalid',
      )
    }

    // 文件未被污染：仍只有种子记录，且没有任何临时文件残留。
    expect(await readFile(filePath, 'utf8')).toBe(seeded)
    expect((await store.list()).map((record) => record.key)).toEqual(['gh-seed'])
    const leftovers = (await readdir(tmp)).filter((name) => name.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('applies the cross-consistent default for an absent classification', async () => {
    const file = join(tmp, 'undefined-input.json')
    // The type-level reading of "an explicit undefined classification": with
    // `exactOptionalPropertyTypes` the `classification?` field of the store's
    // input cannot be handed `undefined` at all, so the only reachable shapes
    // are "the property is absent" (this case) and "the serialized value is
    // null" (the legacy case below). Both are asserted through the public API
    // instead of a type-violating call.
    const entryLess = await new PluginRecordStore(file).add({
      key: key('gh-undef-less'),
      source: githubSource,
      localDirName: 'gh-undef-less',
    })
    expect(entryLess.classification).toBe('other')
    const raw = JSON.parse(await readFile(file, 'utf8')) as { records: Record<string, { classification?: string }> }
    expect(raw.records['gh-undef-less']?.classification).toBe('other')
  })

  it('rejects an entry-less record explicitly classified plugin (write-boundary cross-check)', async () => {
    const file = join(tmp, 'contradiction.json')
    const store = new PluginRecordStore(file)
    await rejectCode(
      store.add({
        key: key('gh-contradiction'),
        source: githubSource,
        localDirName: 'gh-contradiction',
        classification: 'plugin',
      }),
      'record/invalid',
    )
    await rejectCode(
      store.register({
        key: key('gh-contradiction'),
        source: githubSource,
        localDirName: 'gh-contradiction',
        classification: 'plugin',
      }),
      'record/invalid',
    )
    expect(await store.list()).toEqual([])
    const raw = JSON.parse(await readFile(file, 'utf8')) as { records: Record<string, unknown> }
    expect(raw.records).toEqual({})
  })
})

/* ======================================================================== */
/* 2. 旧记录兼容读 + entry=null 记录更新稳定性                                */
/* ======================================================================== */

describe('[挑战] legacy records（无标签 / JSON null）与 entry=null 记录的更新稳定性', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-records-legacy') })
  afterAll(async () => { await removeTmp(tmp) })

  it('reads a tag-less record as plugin, and keeps it through setEnabled/setTrusted', async () => {
    const file = join(tmp, 'legacy.json')
    const body = recordBody({ key: 'gh-legacy', localDirName: 'gh-legacy', entry: 'index.js' })
    delete body['classification']
    await writeFile(file, JSON.stringify({ schemaVersion: 1, records: { 'gh-legacy': body } }), 'utf8')

    const store = new PluginRecordStore(file)
    expect((await store.get(key('gh-legacy')))?.classification).toBe('plugin')

    const enabled = await store.setEnabled(key('gh-legacy'), true)
    expect(enabled).toMatchObject({ classification: 'plugin', entry: 'index.js', enabled: true })

    const trusted = await new PluginRecordStore(file).setTrusted(key('gh-legacy'), 'trusted')
    expect(trusted).toMatchObject({ classification: 'plugin', entry: 'index.js', trusted: 'trusted' })

    // 重写后的文件携带显式标签，且原 entry 未被抹掉。
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      records: Record<string, { classification?: string; entry?: string | null }>
    }
    expect(raw.records['gh-legacy']?.classification).toBe('plugin')
    expect(raw.records['gh-legacy']?.entry).toBe('index.js')
  })

  it('reads an explicit JSON null tag as plugin and keeps entry null stable across flips', async () => {
    const file = join(tmp, 'null-tag.json')
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      records: { 'gh-null': recordBody({ key: 'gh-null', localDirName: 'gh-null', classification: null }) },
    }), 'utf8')

    const store = new PluginRecordStore(file)
    expect((await store.get(key('gh-null')))?.classification).toBe('plugin')

    await store.setEnabled(key('gh-null'), true)
    const off = await new PluginRecordStore(file).setEnabled(key('gh-null'), false)
    expect(off).toMatchObject({ classification: 'plugin', entry: null, enabled: false })
  })

  it('keeps an entry=null skills record stable across repeated enable/trust updates', async () => {
    const file = join(tmp, 'skills-null-entry.json')
    const store = new PluginRecordStore(file)
    await store.add({ key: key('gh-skills'), source: githubSource, localDirName: 'gh-skills', classification: 'skills' })

    await store.setEnabled(key('gh-skills'), true)
    await store.setTrusted(key('gh-skills'), 'trusted')
    const back = await new PluginRecordStore(file).setEnabled(key('gh-skills'), false)
    expect(back).toMatchObject({ classification: 'skills', entry: null, enabled: false, trusted: 'trusted' })

    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      records: Record<string, { classification?: string; entry?: string | null }>
    }
    expect(raw.records['gh-skills']?.classification).toBe('skills')
    expect(raw.records['gh-skills']?.entry).toBeNull()
  })

  it('registers an entry-less checkout without inventing an entry, and overwrite keeps the new tag', async () => {
    const file = join(tmp, 'overwrite.json')
    const store = new PluginRecordStore(file)
    await store.register({ key: key('gh-own'), source: githubSource, localDirName: 'gh-own', classification: 'skills' })
    const replaced = await store.register({
      key: key('gh-own'),
      source: githubSource,
      localDirName: 'gh-own',
      classification: 'other',
    })
    expect(replaced).toMatchObject({ classification: 'other', entry: null })
    expect(await store.list()).toHaveLength(1)
  })

  it('observation: the store does not cross-validate a non-null entry against skills/other', async () => {
    // 当前实现只做单字段校验；安装管线不会产生这种组合（entry 恒为 null），
    // 但 store 层接受并原样往返。此断言固定现状，便于日后有意收紧时被发现。
    const file = join(tmp, 'mixed.json')
    const store = new PluginRecordStore(file)
    const record = await store.add({
      key: key('gh-mixed'),
      source: githubSource,
      localDirName: 'gh-mixed',
      entry: 'index.js',
      classification: 'skills',
    })
    expect(record).toMatchObject({ classification: 'skills', entry: 'index.js' })
    expect((await new PluginRecordStore(file).get(key('gh-mixed')))?.entry).toBe('index.js')
  })
})

/* ======================================================================== */
/* 3. 标签常量与守卫                                                          */
/* ======================================================================== */

describe('[挑战] DEFAULT_PLUGIN_MARKET_CLASSIFICATION 与 isPluginMarketClassification', () => {
  it('exposes plugin as the backward-compatible default', () => {
    expect(DEFAULT_PLUGIN_MARKET_CLASSIFICATION).toBe('plugin')
  })

  it('narrows exactly the three persisted labels', () => {
    for (const value of ['plugin', 'skills', 'other']) expect(isPluginMarketClassification(value)).toBe(true)
    for (const value of ['preset', 'tooling', 'PLUGIN', 'Skills', '', ' plugin', null, undefined, 42, {}, []]) {
      expect(isPluginMarketClassification(value)).toBe(false)
    }
  })
})

/* ======================================================================== */
/* 4. 安装管线：去阻断 + 分类打标                                             */
/* ======================================================================== */

interface Fixture {
  /** undefined = 完全不写 package.json；null = clone 失败。 */
  manifest?: Record<string, unknown> | null
  rawManifest?: string
  files?: string[]
}

function fakeRunner(fixture: Fixture): CommandRunner {
  return async (command, args) => {
    const all = [...args]
    if (command === 'git' && all[0] === 'clone') {
      const target = all[all.length - 1] ?? ''
      await mkdir(target, { recursive: true })
      await mkdir(join(target, '.git'))
      if (fixture.manifest === null) {
        return { code: 128, stdout: '', stderr: 'remote: Repository not found.' } satisfies CommandOutcome
      }
      if (fixture.manifest !== undefined) {
        await writeFile(join(target, 'package.json'), fixture.rawManifest ?? JSON.stringify(fixture.manifest), 'utf8')
      }
      for (const file of fixture.files ?? []) {
        const segments = file.split('/')
        const name = segments.pop() ?? ''
        if (name === '') continue
        await mkdir(join(target, ...segments), { recursive: true })
        await writeFile(join(target, ...segments, name), 'export const value = 1\n', 'utf8')
      }
      return { code: 0, stdout: '', stderr: '' } satisfies CommandOutcome
    }
    if (command === 'git' && all.includes('rev-parse')) {
      return { code: 0, stdout: 'c'.repeat(40), stderr: '' } satisfies CommandOutcome
    }
    return { code: 0, stdout: '', stderr: '' } satisfies CommandOutcome
  }
}

describe('[挑战] install 去阻断：无入口核查一律入库，绝不再抛 install/entry-missing', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-install-unblock') })
  afterAll(async () => { await removeTmp(tmp) })

  /** 执行一次安装；抛出时把错误一并返回，便于断言错误码。 */
  async function attempt(name: string, fixture: Fixture, extra: Record<string, unknown> = {}) {
    const root = join(tmp, name)
    await mkdir(root)
    const installer = new PluginInstaller({ run: fakeRunner(fixture) })
    try {
      const result = await installer.install({
        repositoryRoot: root,
        key: key(`gh-${name}`),
        ownerRepo: `owner/${name}`,
        localDirName: `gh-${name}`,
        confirmed: true,
        ...extra,
      })
      return { root, result, error: null as MarketError | null }
    } catch (error) {
      return { root, result: null, error: error as MarketError }
    }
  }

  it('manifest 入口缺失且无 index.js → 入库为 other（而非抛错）', async () => {
    const { root, result, error } = await attempt('no-entry', { manifest: { main: 'lib/main.js' }, files: ['lib/other.js'] })
    expect(error).toBeNull()
    expect(result).toMatchObject({ classification: 'other', entry: null })
    expect(result?.entryNote).toContain('lib/main.js')
    expect(result?.record).toMatchObject({ classification: 'other', entry: null })
    expect(await readdir(root)).toContain('gh-no-entry')
  })

  it('显式 entry 缺失且无 index.js → 入库为 other', async () => {
    const { result, error } = await attempt('explicit-missing', { manifest: { name: 'x' }, files: ['README.md'] }, { entry: 'dist/plugin.js' })
    expect(error).toBeNull()
    expect(result).toMatchObject({ classification: 'other', entry: null })
    expect(result?.entryNote).toContain('dist/plugin.js')
  })

  it('package.json 非法且无 index.js → 入库为 other，提示提到 package.json', async () => {
    const { result, error } = await attempt('broken-manifest', { manifest: {}, rawManifest: '{ not json', files: ['README.md'] })
    expect(error).toBeNull()
    expect(result).toMatchObject({ classification: 'other', entry: null })
    expect(result?.entryNote).toContain('package.json')
  })

  it('完全没有 package.json 且无 index.js → 入库为 other，提示提到 package.json', async () => {
    const { result, error } = await attempt('no-manifest', { files: ['skills/SKILL.md'] })
    expect(error).toBeNull()
    expect(result).toMatchObject({ classification: 'other', entry: null })
    expect(result?.entryNote).toContain('package.json')
  })

  it('回归：四种无入口场景都不得以 install/entry-missing 失败', async () => {
    const cases: { name: string; fixture: Fixture; extra?: Record<string, unknown> }[] = [
      { name: 'reg-1', fixture: { manifest: { main: 'lib/main.js' }, files: [] } },
      { name: 'reg-2', fixture: { manifest: { name: 'x' }, files: [] }, extra: { entry: 'dist/plugin.js' } },
      { name: 'reg-3', fixture: { manifest: {}, rawManifest: 'nope', files: [] } },
      { name: 'reg-4', fixture: { files: [] } },
    ]
    for (const item of cases) {
      const { error } = await attempt(item.name, item.fixture, item.extra ?? {})
      expect(error).toBeNull()
    }
  })

  it('静态回归：src/host/market/**（错误码字典除外）不再出现 install/entry-missing 字面量', async () => {
    const dir = join(process.cwd(), 'src', 'host', 'market')
    const offenders: string[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.ts') || name === 'errors.ts') continue
      const text = await readFile(join(dir, name), 'utf8')
      if (text.includes('install/entry-missing')) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })
})

describe('[挑战] install 分类打标：入口探测优先 + 回退顺序 + 记录往返', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-install-tags') })
  afterAll(async () => { await removeTmp(tmp) })

  async function install(name: string, fixture: Fixture, extra: Record<string, unknown> = {}) {
    const root = join(tmp, name)
    await mkdir(root)
    const installer = new PluginInstaller({ run: fakeRunner(fixture) })
    const result = await installer.install({
      repositoryRoot: root,
      key: key(`gh-${name}`),
      ownerRepo: `owner/${name}`,
      localDirName: `gh-${name}`,
      confirmed: true,
      ...extra,
    })
    return { root, result }
  }

  it('入口探测优先：显式 classification=skills 遇到真实入口时仍落 plugin（不降级可运行插件）', async () => {
    const { root, result } = await install('skills-hint-plugin', { manifest: { main: 'index.js' }, files: ['index.js'] }, { classification: 'skills' })
    expect(result).toMatchObject({ classification: 'plugin', entry: 'index.js' })
    expect(result.record).toMatchObject({ classification: 'plugin', entry: 'index.js' })
    expect((await new PluginRecordStore(repositoryRecordsPath(root)).get(key('gh-skills-hint-plugin')))?.classification).toBe('plugin')
  })

  it('显式 classification=other 同样不能降级带入口的检出', async () => {
    const { result } = await install('other-hint-plugin', { manifest: { main: 'index.js' }, files: ['index.js'] }, { classification: 'other' })
    expect(result).toMatchObject({ classification: 'plugin', entry: 'index.js' })
  })

  it('显式 classification 仅在检出无可执行入口时生效（skills 归并 + 坏清单也照常入库）', async () => {
    const noEntry = await install('skills-hint-no-entry', { manifest: { main: 'lib/missing.js' }, files: ['SKILL.md'] }, { classification: 'skills' })
    expect(noEntry.result).toMatchObject({ classification: 'skills', entry: null })
    // 无入口的检出同样跳过依赖步骤（pnpm 不会运行）。
    expect(noEntry.result.dependenciesInstalled).toBe(false)

    const broken = await install('skills-broken', { manifest: {}, rawManifest: '{{{', files: ['SKILL.md'] }, { classification: 'skills' })
    expect(broken.result).toMatchObject({ classification: 'skills', entry: null })
    expect(broken.result.entryNote).toContain('package.json')
  })

  it('入口回退顺序：显式 entry > manifest main > exports["."] > index.js', async () => {
    const first = await install('explicit-wins', {
      manifest: { main: 'lib/main.js' },
      files: ['custom.js', 'lib/main.js', 'index.js'],
    }, { entry: 'custom.js' })
    expect(first.result).toMatchObject({ classification: 'plugin', entry: 'custom.js' })

    // 观察：入口解析分两步——先取第一个「可归一化」的候选（显式 entry > main > exports
    // > index.js），再对 [解析结果, index.js] 逐个探询存在性。因此显式 entry 语法合法
    // 但文件缺失时，回退到 index.js，而不会退回 manifest main。
    const second = await install('explicit-missing-falls-to-index', {
      manifest: { main: './lib/main.js' },
      files: ['lib/main.js', 'index.js'],
    }, { entry: 'dist/absent.js' })
    expect(second.result).toMatchObject({ classification: 'plugin', entry: 'index.js' })

    // 无显式 entry 时 manifest main 仍是首选（'./lib/main.js' 归一化后探询存在性）。
    const mainFirst = await install('main-wins', {
      manifest: { main: './lib/main.js' },
      files: ['lib/main.js', 'index.js'],
    })
    expect(mainFirst.result).toMatchObject({ classification: 'plugin', entry: 'lib/main.js' })

    // 反证：显式 entry 缺失 + 无 index.js 时，即使 manifest main 对应的文件存在，
    // 也不会退回 main —— 仍按 other 入库（entryNote 指向被解析的显式 entry）。
    const noMainFallback = await install('explicit-missing-no-main-fallback', {
      manifest: { main: 'lib/main.js' },
      files: ['lib/main.js'],
    }, { entry: 'dist/absent.js' })
    expect(noMainFallback.result).toMatchObject({ classification: 'other', entry: null })
    expect(noMainFallback.result.entryNote).toContain('dist/absent.js')

    const third = await install('exports-wins', {
      manifest: { exports: { '.': { import: 'dist/entry.js' } } },
      files: ['dist/entry.js', 'index.js'],
    })
    expect(third.result).toMatchObject({ classification: 'plugin', entry: 'dist/entry.js' })

    const fourth = await install('index-fallback', { manifest: { main: 'lib/missing.js' }, files: ['index.js'] })
    expect(fourth.result).toMatchObject({ classification: 'plugin', entry: DEFAULT_CHECKOUT_ENTRY })
    // 成功路径不留临时目录
    expect((await readdir(fourth.root)).some((name) => name.startsWith('.install-'))).toBe(false)
  })

  it('安装返回值与落盘记录往返一致（classification/entry）', async () => {
    const { root, result } = await install('roundtrip', { manifest: { main: 'lib/only.js' }, files: ['lib/only.js'] })
    const reloaded = await new PluginRecordStore(repositoryRecordsPath(root)).get(key('gh-roundtrip'))
    expect(reloaded?.classification).toBe(result.classification)
    expect(reloaded?.entry).toBe(result.entry)
    expect(result.classification).toBe('plugin')
    expect(result.entry).toBe('lib/only.js')
  })
})

/* ======================================================================== */
/* 5. 分析器：分布映射 / 探针 / 错误码                                        */
/* ======================================================================== */

describe('[挑战] resolveAnalysisDistribution 绝不抛错且映射完备', () => {
  it('is the same function object as the historical resolveAnalysisVerdict alias', () => {
    expect(resolveAnalysisDistribution).toBe(resolveAnalysisVerdict)
  })

  it('maps every analyzer kind × entryPresent combination without throwing', () => {
    const kinds = ['plugin', 'skills', 'preset', 'tooling', 'other'] as const
    const present = [undefined, true, false] as const
    for (const kind of kinds) {
      for (const entryPresent of present) {
        const raw: RawCheckoutAnalysis = { kind, reason: `it is ${kind}`, entryHint: kind === 'plugin' ? 'dist/x.js' : null }
        const options = entryPresent === undefined ? {} : { entryPresent }
        const result = resolveAnalysisDistribution(raw, options)
        expect(result.reason.length).toBeGreaterThan(0)
        if (kind === 'plugin' && entryPresent === false) {
          expect(result).toMatchObject({ classification: 'other', entry: null, entryHint: 'dist/x.js', buildRequired: true })
          expect(result.reason).toContain('dist/x.js')
          expect(result.reason).toContain(`it is ${kind}`)
        } else if (kind === 'plugin') {
          expect(result).toMatchObject({ classification: 'plugin', entry: 'dist/x.js', buildRequired: false, reason: `it is ${kind}` })
        } else if (kind === 'skills') {
          expect(result).toMatchObject({ classification: 'skills', entry: null, buildRequired: false, reason: `it is ${kind}` })
        } else {
          expect(result).toMatchObject({ classification: 'other', entry: null, buildRequired: false, reason: `it is ${kind}` })
        }
      }
    }
  })

  it('falls back to index.js for a plugin answer with no entryHint', () => {
    expect(resolveAnalysisDistribution({ kind: 'plugin', reason: 'plain plugin', entryHint: null }))
      .toMatchObject({ classification: 'plugin', entry: DEFAULT_CHECKOUT_ENTRY, entryHint: null })
  })

  it('keeps a non-plugin entryHint on the result while forcing entry null', () => {
    expect(resolveAnalysisDistribution({ kind: 'skills', reason: 'pack', entryHint: 'index.js' }))
      .toMatchObject({ classification: 'skills', entry: null, entryHint: 'index.js' })
  })
})

describe('[挑战] probeCheckoutEntry 语义', () => {
  it('returns undefined when no probe is injected', async () => {
    expect(await probeCheckoutEntry(undefined, 'index.js')).toBeUndefined()
  })

  it('passes truthy and falsy probe answers through', async () => {
    expect(await probeCheckoutEntry(() => true, 'index.js')).toBe(true)
    expect(await probeCheckoutEntry(async () => false, 'index.js')).toBe(false)
  })

  it('normalizes a native probe failure to market/io carrying the entry path and cause', async () => {
    const error = await probeCheckoutEntry(() => { throw new Error('EACCES boom') }, 'lib/entry.js')
      .catch((e: unknown) => e as MarketError)
    expect(error).toBeInstanceOf(MarketError)
    // The probe surface is `boolean | undefined`; the cast above keeps the
    // failure branch addressable (this test only runs it on a throw).
    const failure = error as MarketError
    expect(failure.code).toBe('market/io')
    expect(failure.message).toContain('lib/entry.js')
    expect(failure.message).toContain('EACCES boom')
  })

  it('rethrows an existing MarketError unchanged', async () => {
    const original = new MarketError('market/io', 'already normalized')
    const error = await probeCheckoutEntry(() => { throw original }, 'index.js').catch((e: unknown) => e as MarketError)
    expect(error).toBe(original)
  })
})

/** 最小分析输入。 */
function snapshotOf(): CheckoutSnapshot {
  return { readme: '# readme', entries: [{ name: 'index.js', directory: false }], topLevelCount: 1, manifest: null }
}

describe('[挑战] InstallAnalyzer 失败码与不阻断语义', () => {
  it('throws market/llm-unconfigured without invoking the completion when provider/model are absent', async () => {
    let called = false
    const analyzer = new InstallAnalyzer({
      complete: async () => { called = true; return '{}' },
    })
    await rejectCode(analyzer.analyze(snapshotOf()), 'market/llm-unconfigured')
    expect(called).toBe(false)
  })

  it('throws market/llm-unconfigured when only the model is missing', async () => {
    const analyzer = new InstallAnalyzer({ complete: async () => '{}', provider: 'p' })
    await rejectCode(analyzer.analyze(snapshotOf()), 'market/llm-unconfigured')
  })

  it('maps a completion throw to market/llm-failed and keeps the cause text', async () => {
    const analyzer = new InstallAnalyzer({
      complete: async () => { throw new Error('socket closed') },
      provider: 'p',
      model: 'm',
    })
    const error = await rejectCode(analyzer.analyze(snapshotOf()), 'market/llm-failed')
    expect(error.message).toContain('socket closed')
  })

  it('maps bad output to market/llm-bad-output', async () => {
    const analyzer = new InstallAnalyzer({ complete: async () => 'not json', provider: 'p', model: 'm' })
    await rejectCode(analyzer.analyze(snapshotOf()), 'market/llm-bad-output')
  })

  it('maps a native hasFile probe failure to market/io', async () => {
    const analyzer = new InstallAnalyzer({
      complete: async () => JSON.stringify({ kind: 'plugin', reason: 'plugin', entryHint: 'index.js' }),
      provider: 'p',
      model: 'm',
      hasFile: () => { throw new Error('stat blew up') },
    })
    const error = await rejectCode(analyzer.analyze(snapshotOf()), 'market/io')
    expect(error.message).toContain('index.js')
    expect(error.message).toContain('stat blew up')
  })

  it('files a plugin whose probed entry is absent as other with buildRequired (no refusal, no throw)', async () => {
    const analyzer = new InstallAnalyzer({
      complete: async () => JSON.stringify({ kind: 'plugin', reason: 'needs build', entryHint: 'dist/index.js' }),
      provider: 'p',
      model: 'm',
      hasFile: () => false,
    })
    const distribution = await analyzer.analyze(snapshotOf())
    expect(distribution).toMatchObject({ classification: 'other', entry: null, buildRequired: true })
  })

  it('classifies a plugin whose entry is present as plugin', async () => {
    const analyzer = new InstallAnalyzer({
      complete: async () => JSON.stringify({ kind: 'plugin', reason: 'ok', entryHint: 'index.js' }),
      provider: 'p',
      model: 'm',
      hasFile: () => true,
    })
    expect(await analyzer.analyze(snapshotOf())).toMatchObject({ classification: 'plugin', entry: 'index.js' })
  })
})

describe('[挑战] runCheckoutAnalysis 控制层缝隙', () => {
  it('returns the classification distribution instead of a verdict (classification is not a gate)', async () => {
    const plugin = await runCheckoutAnalysis(snapshotOf(), {
      complete: async () => JSON.stringify({ kind: 'plugin', reason: 'ok', entryHint: 'index.js' }),
      provider: 'p',
      model: 'm',
      hasFile: () => true,
    })
    expect(plugin).toMatchObject({ classification: 'plugin', entry: 'index.js', buildRequired: false })

    // A skills answer is a filing decision, not a refusal: the caller files the
    // checkout under the returned tag.
    const skills = await runCheckoutAnalysis(snapshotOf(), {
      complete: async () => JSON.stringify({ kind: 'skills', reason: 'a pack' }),
      provider: 'p',
      model: 'm',
    })
    expect(skills).toMatchObject({ classification: 'skills', entry: null, reason: 'a pack', buildRequired: false })
  })

  it('folds a plugin without a present entry into other + buildRequired (still no throw)', async () => {
    const buildFirst = await runCheckoutAnalysis(snapshotOf(), {
      complete: async () => JSON.stringify({ kind: 'plugin', reason: 'needs build', entryHint: 'dist/index.js' }),
      provider: 'p',
      model: 'm',
      hasFile: () => false,
    })
    expect(buildFirst).toMatchObject({
      classification: 'other',
      entry: null,
      entryHint: 'dist/index.js',
      buildRequired: true,
    })
  })

  it('propagates market/io from the entry probe instead of silently passing', async () => {
    const promise = runCheckoutAnalysis(snapshotOf(), {
      complete: async () => JSON.stringify({ kind: 'plugin', reason: 'ok', entryHint: 'index.js' }),
      provider: 'p',
      model: 'm',
      hasFile: () => { throw new Error('probe exploded') },
    })
    await expect(promise).rejects.toMatchObject({ code: 'market/io' })
  })
})

/* ======================================================================== */
/* 6. 观察项：显式 entry 的严格校验（与 manifest 入口的归一化不对称）          */
/* ======================================================================== */

describe('[挑战][观察] install 显式 entry 走严格校验，manifest 入口走归一化', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-install-entry-shape') })
  afterAll(async () => { await removeTmp(tmp) })

  it('rejects an un-normalized explicit entry ("./x.js") with record/invalid before any side effect', async () => {
    const root = join(tmp, 'strict')
    await mkdir(root)
    const installer = new PluginInstaller({
      run: fakeRunner({ manifest: { main: 'lib/main.js' }, files: ['lib/main.js', 'index.js'] }),
    })
    const error = await rejectCode(installer.install({
      repositoryRoot: root,
      key: key('gh-strict'),
      ownerRepo: 'owner/strict',
      localDirName: 'gh-strict',
      entry: './lib/main.js',
      confirmed: true,
    }), 'record/invalid')
    expect(error.message).toContain('./lib/main.js')
    // 无副作用：无检出目录、无记录文件。
    expect(await readdir(root)).toEqual([])
  })

  it('normalizes the same "./lib/main.js" when it comes from the manifest main field', async () => {
    const root = join(tmp, 'normalized')
    await mkdir(root)
    const installer = new PluginInstaller({
      run: fakeRunner({ manifest: { main: './lib/main.js' }, files: ['lib/main.js', 'index.js'] }),
    })
    const result = await installer.install({
      repositoryRoot: root,
      key: key('gh-normalized'),
      ownerRepo: 'owner/normalized',
      localDirName: 'gh-normalized',
      confirmed: true,
    })
    expect(result).toMatchObject({ classification: 'plugin', entry: 'lib/main.js' })
  })
})

/* ======================================================================== */
/* 7. [跨层验证] 分类标签：控制层按 classification/entry 拒绝装载             */
/* ======================================================================== */

/** 内存 LoaderAdapter：只记录行，不做真实导入。 */
class FakeLoaderAdapter implements LoaderAdapter {
  private readonly rows = new Map<string, LoaderEntryView>()

  entries(): readonly LoaderEntryView[] {
    return [...this.rows.values()]
  }

  async create(input: { id: string; moduleName: string; disabled: boolean }): Promise<void> {
    this.rows.set(input.id, {
      id: input.id,
      moduleName: input.moduleName,
      disabled: input.disabled,
      phase: input.disabled ? null : 'active',
    })
  }

  async update(id: string, options: { disabled?: boolean }): Promise<void> {
    const row = this.rows.get(id)
    if (row === undefined) return
    const disabled = options.disabled ?? row.disabled
    this.rows.set(id, { ...row, disabled, phase: disabled ? null : 'active' })
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id)
  }

  async idle(): Promise<void> {}
}

describe('[跨层验证] 控制层按 classification/entry 拒绝装载非 plugin 记录', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-control-classification') })
  afterAll(async () => { await removeTmp(tmp) })

  it('keeps the disabled row of a skills record but refuses to enable it (market/not-loadable)', async () => {
    const root = join(tmp, 'repo')
    await mkdir(join(root, 'gh-skills-pack'), { recursive: true })
    await writeFile(join(root, 'gh-skills-pack', 'SKILL.md'), '# skills\n', 'utf8')

    const store = new PluginRecordStore(repositoryRecordsPath(root))
    await store.add({ key: key('gh-skills-pack'), source: githubSource, localDirName: 'gh-skills-pack', classification: 'skills' })

    const loader = new FakeLoaderAdapter()
    const controller = new MarketPluginController({
      repositoryRoot: root,
      records: store,
      loader,
      removeDirectory: async () => {},
      protection: { isProtectedKey: isProtectedRecordKey, isSelfModule: () => false },
      entryModuleOf: (record) => entryModuleName(root, record),
      entryDirectoryOf: (record) => join(root, record.localDirName),
      logger: { warn: () => {}, error: () => {} },
    })
    await controller.rebuild()

    // 落盘记录（skills、entry=null）仍拿到 loader 行，但行保持停用：控制层不会
    // 导入一个不存在的入口。装载门禁在 setEnabled 处，且投影 loadable=false。
    const record = await store.get(key('gh-skills-pack'))
    // Narrow once instead of casting at each use: the helpers below take a real
    // `PluginMarketRecord`, and the store just returned one.
    expect(record).not.toBeNull()
    if (record === null) throw new Error('the skills record was not persisted')
    const rows = loader.entries()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.moduleName).toBe(entryModuleName(root, record))
    expect(resolveEntryPath(root, record)).toBe(join(root, 'gh-skills-pack', 'index.js'))
    expect(rows[0]).toMatchObject({ disabled: true, phase: null })
    expect((await controller.list()).entries[0]).toMatchObject({ key: 'gh-skills-pack', loadable: false })

    // 启用被稳定拒绝：market/not-loadable + reason=classification，且没有任何
    // 持久化或 loader 副作用。
    const failure = await controller.setEnabled(key('gh-skills-pack'), true).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'market/not-loadable',
      details: { key: 'gh-skills-pack', reason: 'classification' },
    })
    expect((await store.get(key('gh-skills-pack')))?.enabled).toBe(false)
    expect(loader.entries()[0]).toMatchObject({ disabled: true, phase: null })

    // 删除（两步协议）对非 plugin 记录依然可用。
    const request = await controller.requestRemove(key('gh-skills-pack'))
    expect(request.key).toBe(key('gh-skills-pack'))
    const outcome = await controller.confirmRemove(key('gh-skills-pack'), request.token)
    expect(outcome).toMatchObject({ removedEntry: true, removedRecord: true })
  })
})
