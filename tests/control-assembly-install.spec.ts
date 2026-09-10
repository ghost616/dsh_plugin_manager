/**
 * Production-assembly spec: the REAL `apply()` activation chain (not the
 * injectable fakes of control-source.spec) driven through a real
 * `PluginInstaller`, so the activation wiring itself is under test.
 *
 * Why this file exists: the source layer hands the reviewed classification to
 * the `InstallerPort`, and the production adapter must forward it into
 * `PluginInstaller.install()`. A missing forward is invisible to tsc (the field
 * is optional) and invisible to the fake-engine specs (they implement the port
 * themselves), which is exactly how the "install writes the classification"
 * requirement silently regressed once. The adapter's own field mapping is
 * asserted by control-installer-port.spec.ts (real installer + fake runner);
 * this file proves the assembly END-TO-END: loader + repository service +
 * control row + real `git clone` + real entry probe + real records file.
 *
 * The clone is served locally: a bare fixture repository is stood up in the
 * temp directory and `git` itself is told (through GIT_CONFIG_* environment
 * variables, no global config touched) to rewrite the GitHub clone URL onto it,
 * so the pipeline runs its real clone and probe without network access.
 *
 * Scope note: the cases below use checkouts with NO runnable entry, which is
 * what the download of an unconventional repository looks like. That keeps the
 * dependency step out of the picture (the host pipeline only runs `pnpm install`
 * for a classified plugin with a readable manifest), so the spec never depends
 * on a package manager being installed in the test environment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PluginRecordStore } from '../src/host/market/records.ts'
import { MarketRepositoryService } from '../src/host/market/service.ts'
import type { MarketRepository } from '../src/host/market/index.ts'
import { parsePluginKey } from '../src/host/market/keys.ts'
import { marketControlPlugin } from '../lib/types/host/control/index.js'

const SLUG = 'octocat/demo-plugin'
const PLUGIN_KEY = 'gh-octocat-demo-plugin'
const CLONE_URL = `https://github.com/${SLUG}.git`

/** One checkout the fixture repository commits. */
interface Fixture {
  /** package.json body committed into the checkout, when any. */
  readonly manifest?: Record<string, unknown>
  /** Raw package.json text (overrides `manifest`). */
  readonly rawManifest?: string
  /** Files (relative paths) committed into the checkout. */
  readonly files?: readonly string[]
}

/** Run git inheriting stderr (a failure surfaces as a test error). */
function git(args: readonly string[], cwd?: string): void {
  execFileSync('git', [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

/**
 * Build a bare repository whose default branch `main` carries the fixture and
 * return its path (used as the clone rewrite target).
 */
function buildFixtureRepository(tmp: string, name: string, fixture: Fixture): string {
  const work = join(tmp, `${name}-work`)
  const bare = join(tmp, `${name}-bare`)
  mkdirSync(work, { recursive: true })
  mkdirSync(bare, { recursive: true })
  if (fixture.rawManifest !== undefined) {
    writeFileSync(join(work, 'package.json'), fixture.rawManifest, 'utf8')
  } else if (fixture.manifest !== undefined) {
    writeFileSync(join(work, 'package.json'), JSON.stringify(fixture.manifest, null, 2), 'utf8')
  }
  for (const file of fixture.files ?? []) {
    const target = join(work, ...file.split('/'))
    const parent = target.slice(0, Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/')))
    if (parent.length > 0) mkdirSync(parent, { recursive: true })
    writeFileSync(target, '// fixture entry\n', 'utf8')
  }
  git(['init', '-q', '--initial-branch=main', work])
  git(['-C', work, 'config', 'user.email', 'fixture@example.com'])
  git(['-C', work, 'config', 'user.name', 'fixture'])
  git(['-C', work, 'add', '-A'])
  git(['-C', work, 'commit', '-q', '-m', 'fixture'])
  git(['clone', '-q', '--bare', work, bare])
  return bare
}

/**
 * Run `body` with `git` rewriting the GitHub clone URL onto `target`. The
 * rewrite lives in the child environment only, so no user or global git config
 * is touched.
 */
async function withCloneRewrite<T>(target: string | null, body: () => Promise<T>): Promise<T> {
  const names = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const
  const previous = names.map(name => process.env[name])
  if (target === null) {
    names.forEach(name => { delete process.env[name] })
  } else {
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.${target}.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = CLONE_URL
  }
  try {
    return await body()
  } finally {
    names.forEach((name, index) => {
      const value = previous[index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  }
}

/** Gateway surface of one activated assembly (as the composition resolves it). */
interface GatewaySurface {
  previewInstall(repository: string, refKind: string | null, version: string | null): Promise<{
    classification: string
    confirmToken: string
    note?: { kind: string }
  }>
  install(repository: string, token: string, refKind: string | null, version: string | null): Promise<{
    record: { classification?: string; entry: string | null }
    classification?: string
    entry?: string | null
    dependenciesInstalled?: boolean
  }>
  listManaged(): Promise<{ entries: { key: string; loadable: boolean; record: unknown }[] }>
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('market control production assembly: install files what the checkout is', () => {
  let tmp: string
  let repoRoot: string

  beforeEach(() => {
    tmp = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', `dsh-assembly-install-${randomUUID()}`)
    repoRoot = join(tmp, 'repo')
    mkdirSync(repoRoot, { recursive: true })
    // Seed the records file so the store never has to create-then-rename it in
    // the middle of a preview (that first atomic write can race on Windows).
    writeFileSync(
      join(repoRoot, 'plugins.json'),
      JSON.stringify({ schemaVersion: 1, records: {} }, null, 2),
      'utf8',
    )
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Boot the real composition (loader + repository service + control row). */
  async function activate(): Promise<{ store: PluginRecordStore; ctx: Context; surface: GatewaySurface }> {
    const store = new PluginRecordStore(join(repoRoot, 'plugins.json'))
    const repository: MarketRepository = {
      root: repoRoot,
      records: store,
      harnessLinks: { scopePath: join(repoRoot, 'node_modules', '@deepseek-ai'), links: [] },
      harnessVerified: null,
    }
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    new MarketRepositoryService(ctx, repository)
    await ctx.plugin(marketControlPlugin)
    const surface = (ctx as unknown as { marketControl: GatewaySurface }).marketControl
    return { store, ctx, surface }
  }

  /** Review + install one fixture checkout through the real assembly. */
  async function installFixture(
    surface: GatewaySurface,
    fixture: Fixture,
    name: string,
  ): Promise<Awaited<ReturnType<GatewaySurface['install']>>> {
    const bare = buildFixtureRepository(tmp, name, fixture)
    return await withCloneRewrite(bare, async () => {
      const review = await surface.previewInstall(SLUG, null, null)
      return await surface.install(SLUG, review.confirmToken, null, null)
    })
  }

  it('downloads an entry-less checkout and files its real classification and null entry', async () => {
    const { store, surface } = await activate()
    // Manifest present, its declared entry absent: the host probe finds nothing.
    const outcome = await installFixture(surface, {
      manifest: { name: 'demo-plugin', version: '1.0.0', main: 'index.js', scripts: { build: 'tsc' } },
      files: ['README.md'],
    }, 'entryless')

    expect(outcome.entry).toBeNull()
    expect(outcome.record).toMatchObject({ entry: null })
    expect(outcome.classification).not.toBe('plugin')
    expect(outcome.record.classification).toBe(outcome.classification)
    // Nothing dependencies-related ran for an entry-less checkout.
    expect(outcome.dependenciesInstalled).toBe(false)

    const record = await store.get(parsePluginKey(PLUGIN_KEY))
    expect(record).toMatchObject({ entry: null, enabled: false })
    expect(record?.classification).not.toBe('plugin')
    expect(record?.localDirName).toBe(PLUGIN_KEY)
    expect(record?.source).toMatchObject({ kind: 'github', repository: SLUG })
  })

  it('files an unreadable manifest the same way (no runnable entry, no throw)', async () => {
    const { store, surface } = await activate()
    const outcome = await installFixture(surface, {
      rawManifest: '{{{ not json',
      files: ['SKILL.md'],
    }, 'badmanifest')

    expect(outcome).toMatchObject({ entry: null })
    expect(outcome.record).toMatchObject({ entry: null })
    expect(outcome.record.classification).not.toBe('plugin')
    expect((await store.get(parsePluginKey(PLUGIN_KEY)))?.entry).toBeNull()
  })

  it('lists the entry-less download as not loadable (the tag drives the gate)', async () => {
    const { ctx, surface } = await activate()
    await installFixture(surface, {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['README.md'],
    }, 'notloadable')

    const list = await surface.listManaged()
    const entry = list.entries.find(item => item.key === PLUGIN_KEY)
    expect(entry).toMatchObject({ key: PLUGIN_KEY, loadable: false })
    // A row exists for the managed view, but it was never enabled.
    const rows = [...ctx.loader.entries()].filter(row => row.id === PLUGIN_KEY)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some(row => !row.disabled)).toBe(false)
  })

  it('surfaces a clone failure with the stable install code instead of filing anything', async () => {
    const { store, surface } = await activate()
    // The rewrite points at a path that does not exist, so the real `git clone`
    // fails immediately (a local transport error, not a 20 s network timeout)
    // and the failure must surface as install/git-failed with no record written.
    const error = await withCloneRewrite(join(tmp, 'missing-remote'), async () => {
      const review = await surface.previewInstall(SLUG, null, null)
      return await surface.install(SLUG, review.confirmToken, null, null).catch((caught: unknown) => caught)
    })
    expect(error).toMatchObject({ code: 'install/git-failed' })
    expect(await store.get(parsePluginKey(PLUGIN_KEY))).toBeNull()
  })
})

