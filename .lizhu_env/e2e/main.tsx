/**
 * 离朱 E2E 宿主页：把真实的 ManagePluginsTab 组件挂进一个复刻 dsh 设置壳的
 * 有界容器，并接上确定性的假通道（无网络）。浏览器里跑的是与生产同一份
 * 组件代码与同一份 CSS module。
 */
import { createRoot } from 'react-dom/client'
import { ManagePluginsTab } from '../../src/client/ManagePluginsTab.tsx'
import { zh } from '../../src/client/locales.ts'

const t = (key: string, params?: Record<string, unknown>): string => {
  let text = (zh as Record<string, string>)[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
  }
  return text
}

const now = '2026-01-01T00:00:00.000Z'

/** 40 results on page 1 of a 400-hit search: the list must scroll in-page. */
const SEARCH_TOTAL = 400
const PAGE_SIZE = 40
const search = async (keywords: string, page: number) => ({
  totalCount: SEARCH_TOTAL,
  items: Array.from({ length: PAGE_SIZE }, (_, index) => {
    const n = (page - 1) * PAGE_SIZE + index + 1
    return {
      repository: `acme/plugin-${String(n)}`,
      name: `plugin-${String(n)}`,
      description: `result ${String(n)} for ${keywords === '' ? '<all>' : keywords}`,
      stars: n,
      updatedAt: now,
      url: `https://github.com/acme/plugin-${String(n)}`,
      cloneUrl: `https://github.com/acme/plugin-${String(n)}.git`,
    }
  }),
})

/** A very long README: only the inner scroll zone may absorb it. */
const longReadme = Array.from({ length: 120 }, (_, index) => `## Section ${String(index + 1)}\n\nparagraph body ${String(index + 1)}`).join('\n\n')

const repositoryDetail = async (repository: string) => ({
  repository,
  name: repository.split('/')[1],
  description: 'a dsh plugin',
  stars: 12,
  updatedAt: now,
  url: `https://github.com/${repository}`,
  cloneUrl: `https://github.com/${repository}.git`,
  defaultBranch: 'main',
  branches: ['main', 'next'],
  tags: ['v1.0.0', 'v2.0.0'],
  readme: longReadme,
})

const list = async () => ({
  entries: [
    {
      key: 'gh-acme-plugin-1',
      record: {
        key: 'gh-acme-plugin-1',
        source: { kind: 'github', repository: 'acme/plugin-1', version: 'v1.0.0', commit: null },
        localDirName: 'gh-acme-plugin-1',
        entry: 'index.js',
        classification: 'plugin',
        installedAt: now,
        enabled: true,
        trusted: 'trusted',
        trustedAt: null,
      },
      runtime: { moduleName: 'file:///repo/gh-acme-plugin-1/index.js', disabled: false, phase: 'active', lastError: null },
      loadable: true,
    },
    {
      key: 'gh-acme-skills',
      record: {
        key: 'gh-acme-skills',
        source: { kind: 'github', repository: 'acme/skills-pack', version: 'v1.0.0', commit: null },
        localDirName: 'gh-acme-skills',
        entry: null,
        classification: 'skills',
        installedAt: now,
        enabled: false,
        trusted: 'trusted',
        trustedAt: null,
      },
      runtime: { moduleName: 'file:///repo/gh-acme-skills/index.js', disabled: true, phase: null, lastError: null },
      loadable: false,
    },
  ],
})

const calls = { status: 0, list: 0, setEnabled: 0, search: 0, repositoryDetail: 0, previewInstall: 0, install: 0, confirmRemove: 0 }
;(window as unknown as { __e2e: typeof calls }).__e2e = calls

const props = {
  t,
  close: () => {},
  status: async () => { calls.status += 1; return { configured: true, repositoryPath: '/repo' } },
  list: async () => { calls.list += 1; return list() },
  setEnabled: async (key: string, enabled: boolean) => {
    calls.setEnabled += 1
    return { key, source: { kind: 'github', repository: 'acme/plugin-1', version: 'v1.0.0', commit: null }, localDirName: key, entry: 'index.js', classification: 'plugin', installedAt: now, enabled, trusted: 'trusted', trustedAt: null }
  },
  requestRemove: async (key: string) => { calls.confirmRemove += 1; return { key, token: 'rm-token', expiresAt: '2027-01-01T00:00:00.000Z' } },
  confirmRemove: async (key: string) => { calls.confirmRemove += 1; return { key, removed: true } },
  search: async (keywords: string, page: number) => { calls.search += 1; return search(keywords, page) },
  repositoryDetail: async (repository: string) => { calls.repositoryDetail += 1; return repositoryDetail(repository) },
  previewInstall: async (repository: string, version?: string | null) => {
    calls.previewInstall += 1
    return {
      repository,
      key: `gh-${repository.replace('/', '-')}`,
      preview: { status: 'ready', summary: { name: repository.split('/')[1], version: version ?? '1.0.0', dependencies: { dependencies: ['@deepseek-ai/cordis'], peerDependencies: [] } } },
      exists: true,
      overwrite: true,
      existing: null,
      confirmToken: `token-${repository}`,
      expiresAt: '2027-01-01T00:00:00.000Z',
      classification: 'skills',
      entryNote: 'This checkout ships agent skill packs instead of a plugin entry.',
      buildRequired: true,
    }
  },
  install: async (repository: string, _token: string) => {
    calls.install += 1
    return {
      key: `gh-${repository.replace('/', '-')}`,
      overwritten: true,
      record: { key: `gh-${repository.replace('/', '-')}`, source: { kind: 'github', repository, version: 'v1.0.0', commit: null }, localDirName: 'x', entry: null, classification: 'skills', installedAt: now, enabled: false, trusted: 'trusted', trustedAt: null },
      checkoutDir: `/repo/gh-${repository.replace('/', '-')}`,
    }
  },
}

createRoot(document.getElementById('host')!).render(<ManagePluginsTab {...(props as never)} />)
