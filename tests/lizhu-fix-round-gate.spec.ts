/**
 * 离朱独立验证：审查问题修复轮（依赖步骤门禁 + 入口探测优先）。
 *
 * 针对测试说明逐条独立复现，重点挑战：
 * - §1 依赖步骤门禁：pnpm 在「无清单 / 坏清单 / 非 plugin 检出」三种情形完全不被调用，
 *   且三种情形均成功入库；祖先目录含 package.json 时绝不触碰用户工程；
 *   正常路径 pnpm 恰好一次；pnpm 真失败仍 deps-failed 且回滚无残留。
 * - §2 readCheckoutManifestState / readCheckoutManifest：容忍读 / 严格读 / 注入 fs 生效。
 * - §3 入口探测优先：3 种 hint × 入口存在/缺失 全组合（含 hint='plugin' 不得伪造入口）。
 * - §4 记录写入边界交叉一致性 + 加载侧不做该断言的兼容读。
 * - §5 注释/词表与测试文件格式的静态检查。
 *
 * 纯新增用例，不修改任何既有用例。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PluginMarketKey, PluginMarketSource } from '../src/types.ts'
import { MarketError } from '../src/host/market/errors.ts'
import { NodeFs, type FsLike } from '../src/host/market/fs.ts'
import {
  PluginInstaller,
  readCheckoutManifest,
  readCheckoutManifestState,
  type CommandOutcome,
  type CommandRunner,
} from '../src/host/market/install.ts'
import * as marketIndex from '../src/host/market/index.ts'
import { repositoryRecordsPath } from '../src/host/market/layout.ts'
import { PluginRecordStore } from '../src/host/market/records.ts'
import {
  DEFAULT_PLUGIN_MARKET_CLASSIFICATION,
  isPluginMarketClassification,
  type PluginMarketErrorCode,
} from '../src/types.ts'
import { errno, MemoryFs } from './support/memory-fs.ts'
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

function ok(stdout = ''): CommandOutcome {
  return { code: 0, stdout, stderr: '' }
}

/** 夹具：克隆出的检出内容 + pnpm 的行为（若被调用）。 */
interface GateFixture {
  manifest?: Record<string, unknown>
  rawManifest?: string
  /** 写入一个名为 package.json 的目录（读时 EISDIR）。 */
  packageJsonAsDirectory?: boolean
  /** Only ever read: the `as const` fixture tables pass readonly tuples. */
  files?: readonly string[]
  pnpmCode?: number
  pnpmStderr?: string
}

interface RunnerCall {
  command: string
  args: string[]
  cwd?: string
}

const NO_MANIFEST_STDERR = 'ERR_PNPM_NO_PKG_MANIFEST No package.json found'

/** 记录每一次外部命令调用；pnpm 的行为可配置（默认失败，用于证明它根本不该被调用）。 */
function gatedRunner(fixture: GateFixture): { run: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args: [...args], ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) })
    const all = [...args]
    if (command === 'git' && all[0] === 'clone') {
      const target = all[all.length - 1] ?? ''
      await mkdir(target, { recursive: true })
      await mkdir(join(target, '.git'))
      if (fixture.packageJsonAsDirectory === true) {
        await mkdir(join(target, 'package.json'), { recursive: true })
      } else if (fixture.rawManifest !== undefined) {
        await writeFile(join(target, 'package.json'), fixture.rawManifest, 'utf8')
      } else if (fixture.manifest !== undefined) {
        await writeFile(join(target, 'package.json'), JSON.stringify(fixture.manifest), 'utf8')
      }
      for (const file of fixture.files ?? []) {
        const segments = file.split('/')
        const name = segments.pop() ?? ''
        if (name === '') continue
        await mkdir(join(target, ...segments), { recursive: true })
        await writeFile(join(target, ...segments, name), 'export const value = 1\n', 'utf8')
      }
      return ok()
    }
    if (command === 'git' && all.includes('rev-parse')) return ok('e'.repeat(40))
    if (command === 'pnpm') {
      return { code: fixture.pnpmCode ?? 0, stdout: '', stderr: fixture.pnpmStderr ?? '' }
    }
    return ok()
  }
  return { run, calls }
}

interface Attempt {
  result: Awaited<ReturnType<PluginInstaller['install']>> | null
  error: MarketError | null
  calls: RunnerCall[]
  pnpmCalls: RunnerCall[]
}

/** 执行一次安装，错误也作为结果返回，便于断言「错误码」与「未发生」。 */
async function attempt(
  root: string,
  name: string,
  fixture: GateFixture,
  extra: Record<string, unknown> = {},
): Promise<Attempt> {
  const { run, calls } = gatedRunner(fixture)
  const pnpmCalls = (): RunnerCall[] => calls.filter((call) => call.command === 'pnpm')
  try {
    const result = await new PluginInstaller({ run }).install({
      repositoryRoot: root,
      key: key(name),
      ownerRepo: `owner/${name.replace(/^gh-/, '')}`,
      localDirName: name,
      confirmed: true,
      ...extra,
    })
    return { result, error: null, calls, pnpmCalls: pnpmCalls() }
  } catch (error) {
    return { result: null, error: error as MarketError, calls, pnpmCalls: pnpmCalls() }
  }
}

async function stagingLeftovers(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith('.install-'))
}

/* ======================================================================== */
/* §1 依赖步骤门禁                                                           */
/* ======================================================================== */

describe('[挑战] §1 门禁：无清单 / 坏清单 / 非 plugin 检出时 pnpm 完全不被调用', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-gate') })
  afterAll(async () => { await removeTmp(tmp) })

  /** 每种情形都让 runner 把 pnpm 模拟成 ERR_PNPM_NO_PKG_MANIFEST 失败。 */
  const gated = [
    { label: '完全没有 package.json', fixture: { files: ['README.md'] }, extra: {}, classification: 'other', note: 'Dependencies were not installed' },
    { label: 'package.json 非法 JSON', fixture: { rawManifest: '{ not json', files: ['README.md'] }, extra: {}, classification: 'other', note: 'not valid JSON' },
    { label: 'package.json 是空文件', fixture: { rawManifest: '', files: ['README.md'] }, extra: {}, classification: 'other', note: 'not valid JSON' },
    { label: 'package.json 是数组（非对象）', fixture: { rawManifest: '[1,2,3]', files: ['README.md'] }, extra: {}, classification: 'other', note: 'not a JSON object' },
    { label: 'package.json 是 null（非对象）', fixture: { rawManifest: 'null', files: ['README.md'] }, extra: {}, classification: 'other', note: 'not a JSON object' },
    { label: 'package.json 是字符串（非对象）', fixture: { rawManifest: '"hello"', files: ['README.md'] }, extra: {}, classification: 'other', note: 'not a JSON object' },
    { label: 'package.json 是数字（非对象）', fixture: { rawManifest: '7', files: ['README.md'] }, extra: {}, classification: 'other', note: 'not a JSON object' },
    { label: 'package.json 不可读（目录占位）', fixture: { packageJsonAsDirectory: true, files: ['README.md'] }, extra: {}, classification: 'other', note: 'missing or unreadable' },
    { label: '清单可读但无可执行入口（无 hint）', fixture: { manifest: { main: 'lib/missing.js' }, files: ['README.md'] }, extra: {}, classification: 'other', note: 'not a plugin' },
    { label: '清单可读但无可执行入口（hint=other）', fixture: { manifest: { name: 'docs' }, files: ['docs/index.md'] }, extra: { classification: 'other' }, classification: 'other', note: 'not a plugin' },
    { label: '无可执行入口（hint=skills）', fixture: { manifest: { main: 'lib/missing.js' }, files: ['SKILL.md'] }, extra: { classification: 'skills' }, classification: 'skills', note: 'not a plugin' },
  ] as const

  it.each(gated.map((item, index) => [item.label, index, item] as const))(
    'skips pnpm entirely and files the checkout: %s',
    async (_label, index, item) => {
      const root = join(tmp, `gated-${index}`)
      await mkdir(root)
      const name = `gh-gated-${index}`
      const { result, error, pnpmCalls } = await attempt(root, name, {
        ...item.fixture,
        pnpmCode: 1,
        pnpmStderr: NO_MANIFEST_STDERR,
      }, item.extra)

      expect(error).toBeNull()
      // 核心：pnpm 根本没有被调用（否则会以 ERR_PNPM_NO_PKG_MANIFEST 失败）。
      expect(pnpmCalls).toEqual([])
      expect(result?.classification).toBe(item.classification)
      expect(result?.entry).toBeNull()
      expect(result?.dependenciesInstalled).toBe(false)
      expect(result?.entryNote).toContain('Dependencies were not installed')
      expect(result?.entryNote).toContain(item.note)
      expect(result?.record).toMatchObject({ classification: item.classification, entry: null })
      // 检出落盘、无暂存残留、记录已写入。
      expect(await readdir(root)).toContain(name)
      expect(await stagingLeftovers(root)).toEqual([])
      const reloaded = await new PluginRecordStore(repositoryRecordsPath(root)).get(key(name))
      expect(reloaded?.classification).toBe(item.classification)
    },
  )

  it('even a pnpm that would succeed is never invoked for those checkouts', async () => {
    const root = join(tmp, 'gated-success-runner')
    await mkdir(root)
    const { error, pnpmCalls } = await attempt(root, 'gh-docs-ok', { files: ['README.md'], pnpmCode: 0 })
    expect(error).toBeNull()
    expect(pnpmCalls).toEqual([])
  })

  it('a plugin checkout whose entry exists but whose manifest is absent still skips pnpm', async () => {
    const root = join(tmp, 'entry-without-manifest')
    await mkdir(root)
    const { result, error, pnpmCalls } = await attempt(root, 'gh-entry-only', { files: ['index.js'], pnpmCode: 1, pnpmStderr: NO_MANIFEST_STDERR })
    expect(error).toBeNull()
    expect(pnpmCalls).toEqual([])
    expect(result).toMatchObject({ classification: 'plugin', entry: 'index.js', dependenciesInstalled: false })
    expect(result?.entryNote).toContain('package.json')
  })
})

describe('[挑战] §1 正常路径：pnpm 恰好一次且 cwd 为检出目录', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-gate-normal') })
  afterAll(async () => { await removeTmp(tmp) })

  it('runs pnpm exactly once, inside the checkout, for a readable plugin manifest', async () => {
    const root = join(tmp, 'normal')
    await mkdir(root)
    const finalDir = join(root, 'gh-normal')
    const { result, error, pnpmCalls } = await attempt(root, 'gh-normal', {
      manifest: { name: 'demo', main: 'lib/index.js' },
      files: ['lib/index.js'],
    })
    expect(error).toBeNull()
    expect(pnpmCalls).toHaveLength(1)
    expect(pnpmCalls[0]?.args).toEqual(['install'])
    const cwd = pnpmCalls[0]?.cwd ?? ''
    expect(cwd.startsWith(root)).toBe(true)
    expect(cwd === finalDir || basename(cwd).startsWith('.install-')).toBe(true)
    expect(result).toMatchObject({ classification: 'plugin', entry: 'lib/index.js', dependenciesInstalled: true })
    expect(result?.entryNote).toBeNull()
    expect(await stagingLeftovers(root)).toEqual([])
  })

  it('falls back to the conventional index.js and still installs dependencies', async () => {
    const root = join(tmp, 'fallback')
    await mkdir(root)
    const { result, pnpmCalls } = await attempt(root, 'gh-fallback', {
      manifest: { main: 'lib/not-built.js' },
      files: ['index.js'],
    })
    expect(pnpmCalls).toHaveLength(1)
    expect(result).toMatchObject({ classification: 'plugin', entry: 'index.js', dependenciesInstalled: true })
  })

  it('a real pnpm failure still fails with install/deps-failed and rolls back completely', async () => {
    const root = join(tmp, 'deps-fail')
    await mkdir(root)
    const { error, result, pnpmCalls } = await attempt(root, 'gh-depfail', {
      manifest: { main: 'index.js' },
      files: ['index.js'],
      pnpmCode: 1,
      pnpmStderr: 'ERR_PNPM_FETCH_404 GET https://registry/: Not found',
    })
    expect(result).toBeNull()
    expect(error?.code).toBe('install/deps-failed')
    expect(error?.message).toContain('ERR_PNPM_FETCH_404')
    expect(pnpmCalls).toHaveLength(1)
    const entries = await readdir(root)
    expect(entries).not.toContain('gh-depfail')
    expect(await stagingLeftovers(root)).toEqual([])
    expect(await new PluginRecordStore(repositoryRecordsPath(root)).list()).toEqual([])
  })
})

describe('[挑战] §1 祖先目录含 package.json 时绝不触碰用户工程', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-gate-ancestor') })
  afterAll(async () => { await removeTmp(tmp) })

  it('leaves the enclosing user project byte-identical (no node_modules, no pnpm-lock.yaml)', async () => {
    const project = join(tmp, 'user-project')
    await mkdir(project)
    const lockText = '{"lockfileVersion":3,"packages":{"":{"name":"user-app"}}}'
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'user-app', dependencies: { left: '^1.0.0' } }), 'utf8')
    await writeFile(join(project, 'package-lock.json'), lockText, 'utf8')
    await mkdir(join(project, 'src'))


    const root = join(project, 'market')
    await mkdir(root)
    const before = (await readdir(project)).sort()
    const { result, error, calls } = await attempt(root, 'gh-ancestor', {
      files: ['docs/index.md', 'README.md'],
      pnpmCode: 1,
      pnpmStderr: NO_MANIFEST_STDERR,
    })

    expect(error).toBeNull()
    expect(calls.some((call) => call.command === 'pnpm')).toBe(false)
    // 工程目录：条目集合不变、无 node_modules、无 pnpm-lock.yaml、lockfile 字节不变。
    expect((await readdir(project)).sort()).toEqual(before)
    expect(await readdir(project)).not.toContain('node_modules')
    expect(await readdir(project)).not.toContain('pnpm-lock.yaml')
    expect(await readFile(join(project, 'package-lock.json'), 'utf8')).toBe(lockText)
    // 检出落在市场仓库内，而不是工程内。
    expect(result).toMatchObject({ classification: 'other', entry: null })
    expect(await readdir(root)).toContain('gh-ancestor')
    expect(await readdir(join(root, 'gh-ancestor'))).toContain('docs')
    expect((await readdir(project)).includes('gh-ancestor')).toBe(false)
  })

  it('does not create a lockfile in the user project even when pnpm would have succeeded', async () => {
    const project = join(tmp, 'user-project-ok')
    await mkdir(project)
    await writeFile(join(project, 'package.json'), '{"name":"user-app"}', 'utf8')
    const root = join(project, 'market')
    await mkdir(root)
    const { error } = await attempt(root, 'gh-ancestor-ok', { files: ['notes.md'], pnpmCode: 0 })
    expect(error).toBeNull()
    expect(await readdir(project)).toEqual(expect.arrayContaining(['package.json', 'market']))
    expect(await readdir(project)).not.toContain('node_modules')
    expect(await readdir(project)).not.toContain('pnpm-lock.yaml')
  })
})

/* ======================================================================== */
/* §2 清单读取器                                                             */
/* ======================================================================== */

/** 显式转发全部 FsLike 方法（类实例的方法在原型上，不能靠展开复制）。 */
function objectFs(base: FsLike, readFile: (path: string) => Promise<string>): FsLike {
  return {
    lstat: (path) => base.lstat(path),
    stat: (path) => base.stat(path),
    readFile,
    writeFile: (path, data) => base.writeFile(path, data),
    mkdirp: (dir) => base.mkdirp(dir),
    readdir: (dir) => base.readdir(dir),
    rename: (from, to) => base.rename(from, to),
    unlink: (path) => base.unlink(path),
    rmrf: (path) => base.rmrf(path),
    symlinkDir: (target, link) => base.symlinkDir(target, link),
    realpath: (path) => base.realpath(path),
  }
}

describe('[挑战] §2 readCheckoutManifestState / readCheckoutManifest', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-manifest-reader') })
  afterAll(async () => { await removeTmp(tmp) })

  it('is exported through src/host/market/index.ts', () => {
    expect(typeof marketIndex.readCheckoutManifest).toBe('function')
    expect(typeof marketIndex.readCheckoutManifestState).toBe('function')
  })

  const failures = [
    { label: 'missing file', text: undefined, note: 'missing or unreadable', slug: 'missing' },
    { label: 'empty file', text: '', note: 'not valid JSON', slug: 'empty' },
    { label: 'invalid JSON', text: '{ nope', note: 'not valid JSON', slug: 'bad-json' },
    { label: 'truncated JSON', text: '{"name":', note: 'not valid JSON', slug: 'truncated' },
    { label: 'array', text: '[1,2]', note: 'not a JSON object', slug: 'array' },
    { label: 'null', text: 'null', note: 'not a JSON object', slug: 'null' },
    { label: 'string', text: '"hello"', note: 'not a JSON object', slug: 'string' },
    { label: 'number', text: '7', note: 'not a JSON object', slug: 'number' },
    { label: 'boolean', text: 'true', note: 'not a JSON object', slug: 'boolean' },
  ] as const

  it.each(failures.map((item) => [item.label, item] as const))(
    'tolerates %s as manifest:null with a note',
    async (_label, item) => {
      const dir = join(tmp, `tolerant-${item.slug}`)
      await mkdir(dir)
      if (item.text !== undefined) await writeFile(join(dir, 'package.json'), item.text, 'utf8')
      const state = await readCheckoutManifestState(dir)
      expect(state.manifest).toBeNull()
      expect(state.note).toContain(item.note)
    },
  )

  it.each(failures.map((item) => [item.label, item] as const))(
    'throws install/package-invalid for %s',
    async (_label, item) => {
      const dir = join(tmp, `strict-${item.slug}`)
      await mkdir(dir)
      if (item.text !== undefined) await writeFile(join(dir, 'package.json'), item.text, 'utf8')
      const error = await readCheckoutManifest(dir).catch((e: unknown) => e as MarketError)
      expect(error).toBeInstanceOf(MarketError)
      expect(error.code).toBe('install/package-invalid')
      expect(error.message).toContain('package.json')
      expect(error.message).toContain(item.note)
    },
  )

  it('tolerates an unreadable manifest (path holds a directory) and fails loudly in strict mode', async () => {
    const dir = join(tmp, 'dir-as-manifest')
    await mkdir(dir)
    await mkdir(join(dir, 'package.json'))
    const state = await readCheckoutManifestState(dir)
    expect(state.manifest).toBeNull()
    expect(state.note).toContain('missing or unreadable')
    await expect(readCheckoutManifest(dir)).rejects.toMatchObject({ code: 'install/package-invalid' })
  })

  it('returns a readable manifest object unchanged (nested structures preserved)', async () => {
    const dir = join(tmp, 'readable')
    await mkdir(dir)
    const manifest = {
      name: 'demo',
      version: '1.0.0',
      main: './lib/index.js',
      exports: { '.': { import: 'dist/x.js', require: 'dist/x.cjs' } },
      keywords: ['a', 'b'],
      nested: { deep: { value: 1 } },
    }
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
    const state = await readCheckoutManifestState(dir)
    expect(state).toEqual({ manifest, note: null })
    await expect(readCheckoutManifest(dir)).resolves.toEqual(manifest)
  })

  it('honors an injected FsLike (MemoryFs and a wrapping spy) instead of node:fs', async () => {
    const memory = new MemoryFs()
    await memory.mkdirp('checkout')
    await memory.writeFile('checkout/package.json', JSON.stringify({ name: 'from-memory' }))
    await expect(readCheckoutManifestState('checkout', memory)).resolves.toEqual({ manifest: { name: 'from-memory' }, note: null })
    await expect(readCheckoutManifest('checkout', memory)).resolves.toEqual({ name: 'from-memory' })

    // 注入的 fs 缺失清单 → 与真实 fs 一致地返回 note。
    const empty = new MemoryFs()
    await empty.mkdirp('checkout')
    await expect(readCheckoutManifestState('checkout', empty)).resolves.toEqual({ manifest: null, note: 'the file is missing or unreadable' })

    // 记录 readFile 调用，证明读取确实走注入实现。
    const seen: string[] = []
    const spied = objectFs(memory, async (path) => { seen.push(path); return memory.readFile(path) })
    await expect(readCheckoutManifest('checkout', spied)).resolves.toEqual({ name: 'from-memory' })
    expect(seen.some((path) => path.endsWith('package.json'))).toBe(true)
  })

  it('normalizes a native read failure (non-ENOENT) into the tolerant note / strict error', async () => {
    const failing = objectFs(new MemoryFs(), async () => { throw errno('EACCES', 'permission denied') })
    await expect(readCheckoutManifestState('whatever', failing)).resolves.toEqual({
      manifest: null,
      note: 'the file is missing or unreadable',
    })
    await expect(readCheckoutManifest('whatever', failing)).rejects.toMatchObject({ code: 'install/package-invalid' })
  })
})

/* ======================================================================== */
/* §3 分类判定：入口探测优先                                                  */
/* ======================================================================== */

describe('[挑战] §3 入口探测优先：hint × 入口状态 全组合', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-hint-matrix') })
  afterAll(async () => { await removeTmp(tmp) })

  const hints = ['skills', 'other', undefined] as const

  it.each(hints.map((hint) => [hint ?? '(none)', hint] as const))(
    'entry present + hint=%s → always plugin with that entry (and pnpm runs)',
    async (label, hint) => {
      const name = `gh-present-${label.replace(/[^a-z]/gi, '')}`
      const root = join(tmp, `present-${label.replace(/[^a-z]/gi, '')}`)
      await mkdir(root)
      const { result, error, pnpmCalls } = await attempt(root, name, {
        manifest: { main: 'lib/index.js' },
        files: ['lib/index.js', 'SKILL.md'],
      }, hint === undefined ? {} : { classification: hint })

      expect(error).toBeNull()
      expect(result).toMatchObject({ classification: 'plugin', entry: 'lib/index.js', dependenciesInstalled: true })
      expect(result?.record).toMatchObject({ classification: 'plugin', entry: 'lib/index.js' })
      expect(pnpmCalls).toHaveLength(1)
      expect((await new PluginRecordStore(repositoryRecordsPath(root)).get(key(name)))?.classification).toBe('plugin')
    },
  )

  const noneExpectations = [
    { hint: 'skills', expected: 'skills' },
    { hint: 'other', expected: 'other' },
    { hint: undefined, expected: 'other' },
    { hint: 'plugin', expected: 'other' },
  ] as const

  it.each(noneExpectations.map((item) => [item.hint ?? '(none)', item] as const))(
    'entry absent + hint=%s → %s with entry null and no pnpm',
    async (label, item) => {
      const slug = label.replace(/[^a-z]/gi, '')
      const name = `gh-absent-${slug}`
      const root = join(tmp, `absent-${slug}`)
      await mkdir(root)
      const { result, error, pnpmCalls } = await attempt(root, name, {
        // 清单可读但入口文件未构建；另有一个 README 保证目录非空。
        manifest: { main: 'lib/not-built.js' },
        files: ['README.md'],
      }, item.hint === undefined ? {} : { classification: item.hint })

      expect(error).toBeNull()
      expect(pnpmCalls).toEqual([])
      expect(result?.classification).toBe(item.expected)
      expect(result?.entry).toBeNull()
      expect(result?.dependenciesInstalled).toBe(false)
      expect(result?.entryNote).toContain('lib/not-built.js')
      expect(result?.record).toMatchObject({ classification: item.expected, entry: null })
    },
  )

  it('an explicit plugin hint cannot fabricate an entry (entry probe still wins)', async () => {
    const root = join(tmp, 'plugin-hint-no-entry')
    await mkdir(root)
    const { result, error } = await attempt(root, 'gh-plugin-hint', {
      manifest: { name: 'no-entry' },
      files: ['README.md'],
    }, { classification: 'plugin' })
    expect(error).toBeNull()
    expect(result).toMatchObject({ classification: 'other', entry: null, dependenciesInstalled: false })
    // 交叉一致：entry 为 null 的记录不会以 plugin 落盘（否则写入边界会拒绝）。
    const reloaded = await new PluginRecordStore(repositoryRecordsPath(root)).get(key('gh-plugin-hint'))
    expect(reloaded).toMatchObject({ classification: 'other', entry: null })
  })

  it('a skills hint meets the conventional index.js only (no manifest entry) → plugin', async () => {
    const root = join(tmp, 'skills-hint-index-only')
    await mkdir(root)
    const { result, pnpmCalls } = await attempt(root, 'gh-hint-index', {
      manifest: { name: 'x' },
      files: ['index.js'],
    }, { classification: 'skills' })
    expect(result).toMatchObject({ classification: 'plugin', entry: 'index.js', dependenciesInstalled: true })
    expect(pnpmCalls).toHaveLength(1)
  })
})

/* ======================================================================== */
/* §4 记录写入边界交叉一致性                                                  */
/* ======================================================================== */

describe('[挑战] §4 记录交叉一致性（写入侧断言 / 加载侧不断言）', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-record-cross') })
  afterAll(async () => { await removeTmp(tmp) })

  it('rejects an entry-less explicit-plugin record with zero persistence (add and register)', async () => {
    const file = join(tmp, 'cross.json')
    const store = new PluginRecordStore(file)
    await store.add({ key: key('gh-seed'), source: githubSource, localDirName: 'gh-seed', entry: 'index.js' })
    const seeded = await readFile(file, 'utf8')

    await expect(store.add({
      key: key('gh-bad'),
      source: githubSource,
      localDirName: 'gh-bad',
      classification: 'plugin',
    })).rejects.toMatchObject({ code: 'record/invalid' })

    await expect(store.register({
      key: key('gh-bad'),
      source: githubSource,
      localDirName: 'gh-bad',
      classification: 'plugin',
    })).rejects.toMatchObject({ code: 'record/invalid' })

    expect(await readFile(file, 'utf8')).toBe(seeded)
    expect((await store.list()).map((record) => record.key)).toEqual(['gh-seed'])
    expect((await readdir(tmp)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('defaults cross-consistently and writes the tag explicitly (entry → plugin, no entry → other)', async () => {
    const file = join(tmp, 'defaults.json')
    const store = new PluginRecordStore(file)
    await store.add({ key: key('gh-with-entry'), source: githubSource, localDirName: 'gh-with-entry', entry: 'index.js' })
    await store.add({ key: key('gh-without-entry'), source: githubSource, localDirName: 'gh-without-entry' })

    expect((await store.get(key('gh-with-entry')))?.classification).toBe('plugin')
    expect((await store.get(key('gh-without-entry')))?.classification).toBe('other')

    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      records: Record<string, { classification?: string; entry?: string | null }>
    }
    expect(raw.records['gh-with-entry']?.classification).toBe('plugin')
    expect(raw.records['gh-without-entry']?.classification).toBe('other')
    expect(raw.records['gh-with-entry']?.entry).toBe('index.js')
    expect(raw.records['gh-without-entry']?.entry).toBeNull()
  })

  it('accepts skills/other with a null entry and skills with a non-null entry', async () => {
    const file = join(tmp, 'allowed.json')
    const store = new PluginRecordStore(file)
    const skillsNull = await store.add({ key: key('gh-s1'), source: githubSource, localDirName: 'gh-s1', classification: 'skills' })
    const otherNull = await store.add({ key: key('gh-o1'), source: githubSource, localDirName: 'gh-o1', classification: 'other' })
    const skillsEntry = await store.add({ key: key('gh-s2'), source: githubSource, localDirName: 'gh-s2', entry: 'index.js', classification: 'skills' })

    expect(skillsNull).toMatchObject({ classification: 'skills', entry: null })
    expect(otherNull).toMatchObject({ classification: 'other', entry: null })
    expect(skillsEntry).toMatchObject({ classification: 'skills', entry: 'index.js' })

    const reopened = new PluginRecordStore(file)
    expect((await reopened.get(key('gh-s2')))?.entry).toBe('index.js')
  })

  it('loads a legacy file with classification plugin + entry null (history, not corruption)', async () => {
    const file = join(tmp, 'legacy-plugin-null-entry.json')
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      records: {
        'gh-historic': {
          key: 'gh-historic',
          source: { kind: 'github', repository: 'owner/historic', version: null, commit: null },
          localDirName: 'gh-historic',
          entry: null,
          classification: 'plugin',
          installedAt: '2024-01-01T00:00:00.000Z',
          enabled: false,
          trusted: 'untrusted',
          trustedAt: null,
        },
      },
    }), 'utf8')

    const store = new PluginRecordStore(file)
    const record = await store.get(key('gh-historic'))
    expect(record).toMatchObject({ classification: 'plugin', entry: null })
    // 该历史记录必须仍可被更新（setEnabled 不得因交叉断言而失败）。
    const updated = await store.setEnabled(key('gh-historic'), true)
    expect(updated).toMatchObject({ classification: 'plugin', entry: null, enabled: true })
  })

  it('fails closed when a type-violating null entry is passed (no persistence)', async () => {
    const file = join(tmp, 'typed.json')
    const store = new PluginRecordStore(file)
    let threw = false
    try {
      await store.add({
        key: key('gh-typed'),
        source: githubSource,
        localDirName: 'gh-typed',
        entry: null as unknown as string,
        classification: 'plugin',
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(await store.list()).toEqual([])
    const raw = JSON.parse(await readFile(file, 'utf8')) as { records: Record<string, unknown> }
    expect(raw.records).toEqual({})
  })
})

/* ======================================================================== */
/* §5 契约检查：词表完整 / 无重复生产者 / 源文件格式                          */
/*                                                                          */
/* 断言对象是「契约」而不是注释措辞：词表按类型并集核验、生产者按导出的        */
/* 数据核验、客户端安全按 import 语句语法核验。注释文案可以随时改写。          */
/* ======================================================================== */

/** Every code the wire vocabulary is expected to expose (union membership). */
const WIRE_VOCABULARY = [
  'install/entry-missing',
  'install/package-invalid',
  'market/unsupported-skills',
  'market/unsupported-preset',
  'market/unsupported-build',
  'market/unsupported-other',
] as const satisfies readonly PluginMarketErrorCode[]

/** Codes annotated as producer-less must not be referenced as string literals
 *  by any market module other than the message dictionary. */
const PRODUCER_LESS_CODES = [
  'install/entry-missing',
  'market/unsupported-skills',
  'market/unsupported-preset',
  'market/unsupported-build',
  'market/unsupported-other',
] as const satisfies readonly PluginMarketErrorCode[]

/** 去掉空白，便于在「同一行」问题上与格式无关地做结构断言。 */
function compact(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/**
 * 收集一处 spec 文本里的**全部** `it` 声明行并返回不合规者（声明行未以 `{`
 * 收尾，说明语句被塞进了签名行）。
 *
 * 词法刻意放宽为「行首 `it` + 词边界」，`it` 之后允许任意可行字符，因此
 * `it('…', () => {`、`it.each([[1], [2]])('…', () => {`、
 * `it.skip('…', () => {`、`it.only(…)`、多行参数的起始行等形态都会被纳入检查
 * ——不再依赖「`it.each(<无嵌套括号>)`」这种更窄的猜测，避免静默漏检。
 */
function strayStatementsOnItDeclarations(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*it\b/.test(line) && /[([`'"]/.test(line.slice(line.indexOf('it') + 2)))
    .filter(({ line }) => !line.trim().endsWith('{'))
    .map(({ line, index }) => `${index + 1}: ${line.trim()}`)
}

describe('[挑战] §5 契约检查', () => {
  const root = process.cwd()

  it('every it(...) declaration keeps its body off the signature line', async () => {
    // 该断言守护的是「一行式 it(...) { const ... }」这类编辑残留（真实回归过
    // 一次）。按放宽后的词法找**每一处**声明（与标题措辞、参数个数、修饰符、
    // 参数嵌套深度无关），断言声明行以 `{` 收尾——即语句没有被塞进签名行。
    const text = await readFile(join(root, 'tests', 'market-install.spec.ts'), 'utf8')
    const offenders = strayStatementsOnItDeclarations(text)
    expect(offenders).toEqual([])
    // 反向守卫：本次关注的用例确实存在，避免断言因改名而空转。
    expect(compact(text)).toContain('reports deps-failed and rolls back on a pnpm failure')
    // 且收集词法确实在这份文本里命中了声明（防止词法写错导致零命中）。
    expect(text.split(/\r?\n/).filter((line) => /^\s*it\b/.test(line)).length).toBeGreaterThan(0)
  })

  it.each([
    ["it('x', async () => { const y = 1", 'plain it with a trailing statement'],
    ["it.skip('x', () => { const y = 1", 'it.skip with a trailing statement'],
    ["it.only('x', () => { const y = 1", 'it.only with a trailing statement'],
    ["it.each([[1], [2]])('x', () => { const y = 1", 'it.each with nested array arguments'],
    ["it.each([[1], [2]])('x', () => {", 'it.each with nested arguments but a clean body'],
    ["it('x', () => {", 'plain it with a clean body'],
  ] as const)(
    'the it-collection guard handles %s (%s)',
    (line, _label) => {
      const offenders = strayStatementsOnItDeclarations(`${line}\n  expect(1).toBe(1)\n})\n`)
      if (line.trim().endsWith('{')) {
        expect(offenders).toEqual([])
      } else {
        expect(offenders).toHaveLength(1)
        expect(offenders[0]).toContain('1: ')
      }
    },
  )

  it('src/types.ts stays client-safe: no runtime node:* import or require', async () => {
    // 客户端按值导入本文件（分类词表/守卫/默认值），因此这里只校验真正的
    // 危险项：任何 node:* 运行时依赖。注释措辞不参与断言。
    const text = await readFile(join(root, 'src', 'types.ts'), 'utf8')
    expect(/from\s+'node:/.test(text)).toBe(false)
    expect(/from\s+"node:/.test(text)).toBe(false)
    expect(/require\(\s*['"]node:/.test(text)).toBe(false)
    expect(/\bimport\(\s*['"]node:/.test(text)).toBe(false)
  })

  it('exports the classification vocabulary as runtime values (client-side use)', () => {
    // 类型可以「看起来存在」而运行时被 tree-shake/误改为 type-only 导出；
    // 这里按值断言，保证客户端按值导入的契约不破。
    expect(typeof DEFAULT_PLUGIN_MARKET_CLASSIFICATION).toBe('string')
    expect(DEFAULT_PLUGIN_MARKET_CLASSIFICATION).toBe('plugin')
    expect(typeof isPluginMarketClassification).toBe('function')
    for (const label of ['plugin', 'skills', 'other'] as const) {
      expect(isPluginMarketClassification(label)).toBe(true)
    }
    for (const other of ['preset', 'tooling', 'PLUGIN', '', null, undefined, 7, {}]) {
      expect(isPluginMarketClassification(other)).toBe(false)
    }
  })

  it('keeps the wire vocabulary complete and producer-less codes unreferenced outside the dictionary', async () => {
    // 词表完整性：按类型并集核验（新增码会让 satisfies 直接编译失败），并在
    // 源文件里确认每个码仍然存在，避免被误删。
    const typesText = await readFile(join(root, 'src', 'types.ts'), 'utf8')
    for (const code of WIRE_VOCABULARY) {
      expect(typesText).toContain(`'${code}'`)
    }
    // 无生产者契约：除消息字典 errors.ts 外，市场模块不得再制造这些码。
    const dir = join(root, 'src', 'host', 'market')
    const offenders: { file: string; code: string }[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.ts') || name === 'errors.ts') continue
      const text = await readFile(join(dir, name), 'utf8')
      for (const code of PRODUCER_LESS_CODES) {
        if (text.includes(`'${code}'`)) offenders.push({ file: name, code })
      }
    }
    expect(offenders).toEqual([])
  })

  it('install/package-invalid has exactly one producer module inside src/host/market', async () => {
    // 真扫描：逐文件读源码找码字面量（排除 errors.ts 的消息字典），与上面
    // PRODUCER_LESS_CODES 的扫描手法一致。生产代码不为此暴露任何测试专用导出。
    const dir = join(root, 'src', 'host', 'market')
    const producers: string[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.ts') || name === 'errors.ts') continue
      const text = await readFile(join(dir, name), 'utf8')
      if (text.includes("'install/package-invalid'")) producers.push(name)
    }
    expect(producers).toEqual(['install.ts'])
  })
})

/* ======================================================================== */
/* §1 补充挑战：调用顺序、探针失败、覆盖更新时的回滚与分类切换                 */
/* ======================================================================== */

describe('[挑战] §1 补充：顺序 / 探针异常 / 覆盖更新回滚', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('lizhu-gate-extra') })
  afterAll(async () => { await removeTmp(tmp) })

  it('inspects the checkout before running pnpm (clone precedes pnpm)', async () => {
    const root = join(tmp, 'order')
    await mkdir(root)
    const { calls, error } = await attempt(root, 'gh-order', {
      manifest: { main: 'index.js' },
      files: ['index.js'],
    })
    expect(error).toBeNull()
    const index = calls.findIndex((call) => call.command === 'pnpm')
    expect(index).toBeGreaterThan(0)
    expect(calls[0]).toMatchObject({ command: 'git' })
    expect(calls[0]?.args[0]).toBe('clone')
  })

  it('wraps a native entry-probe failure as install/io and leaves no staging directory', async () => {
    const root = join(tmp, 'probe-failure')
    await mkdir(root)
    let probeCalls = 0
    const fs: FsLike = {
      ...NodeFs,
      stat: async (path) => {
        if (path.endsWith('index.js')) {
          probeCalls += 1
          throw errno('EIO', 'device error')
        }
        return NodeFs.stat(path)
      },
    }
    const { run } = gatedRunner({ manifest: { name: 'x' }, files: ['index.js'] })
    const error = await new PluginInstaller({ fs, run }).install({
      repositoryRoot: root,
      key: key('gh-probe'),
      ownerRepo: 'owner/probe',
      localDirName: 'gh-probe',
      confirmed: true,
    }).catch((e: unknown) => e as MarketError)

    expect(probeCalls).toBeGreaterThan(0)
    expect(error).toBeInstanceOf(MarketError)
    expect((error as MarketError).code).toBe('install/io')
    expect(await stagingLeftovers(root)).toEqual([])
    expect(await readdir(root)).not.toContain('gh-probe')
    expect(await new PluginRecordStore(repositoryRecordsPath(root)).list()).toEqual([])
  })

  it('keeps the previous checkout and record when a same-key overwrite fails at the dependency step', async () => {
    const root = join(tmp, 'overwrite-fail')
    await mkdir(root)
    const first = await attempt(root, 'gh-over', { manifest: { main: 'a.js' }, files: ['a.js'] })
    expect(first.error).toBeNull()
    const before = await readFile(join(root, 'gh-over', 'a.js'), 'utf8')
    const beforeRecord = await new PluginRecordStore(repositoryRecordsPath(root)).get(key('gh-over'))
    expect(beforeRecord?.entry).toBe('a.js')

    const second = await attempt(root, 'gh-over', {
      manifest: { main: 'b.js' },
      files: ['b.js'],
      pnpmCode: 1,
      pnpmStderr: 'ERR_PNPM_FETCH_500 boom',
    })
    expect(second.error?.code).toBe('install/deps-failed')
    // 旧检出与旧记录原样保留。
    expect(await readFile(join(root, 'gh-over', 'a.js'), 'utf8')).toBe(before)
    expect(await stagingLeftovers(root)).toEqual([])
    const after = await new PluginRecordStore(repositoryRecordsPath(root)).get(key('gh-over'))
    expect(after).toEqual(beforeRecord)
  })

  it('switches an existing plugin record to other/null when the overwrite has no runnable entry', async () => {
    const root = join(tmp, 'overwrite-demote')
    await mkdir(root)
    const first = await attempt(root, 'gh-demote', { manifest: { main: 'index.js' }, files: ['index.js'] })
    expect(first.result).toMatchObject({ classification: 'plugin', entry: 'index.js' })

    const second = await attempt(root, 'gh-demote', { manifest: { main: 'lib/not-built.js' }, files: ['README.md'] })
    expect(second.error).toBeNull()
    expect(second.result).toMatchObject({ classification: 'other', entry: null, dependenciesInstalled: false })
    const reloaded = await new PluginRecordStore(repositoryRecordsPath(root)).get(key('gh-demote'))
    expect(reloaded).toMatchObject({ classification: 'other', entry: null })
    expect(await new PluginRecordStore(repositoryRecordsPath(root)).list()).toHaveLength(1)
  })
})
