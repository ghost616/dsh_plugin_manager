/**
 * Self-contained tsdown presets for dsh-plugin-market.
 *
 * Replicates, without the dsh monorepo internal preset, the two artifact
 * contracts this package publishes:
 * - Node half: ESM -> lib/index.js. Production sections (dependencies,
 *   peerDependencies, optionalDependencies) stay bare externals; everything
 *   else inlines.
 * - Browser half: lazy-CJS closure factory -> lib/client.js. The bundle calls
 *   window.__ModuleLoader__.load({ id, factory }) and resolves externals
 *   through the injected require (the shell module table). CSS Modules are
 *   compiled by lightningcss inside the bundle and inject a tagged <style> at
 *   factory execution. NODE_ENV / import.meta.env.MODE are baked by defines.
 *
 * `bundleConfigs` selects the entry roots: the ordinary build consumes the
 * tsc emission under lib/types (tsc first), the git-install `prepare` build
 * consumes src directly (transpile only, no project references, no tsc).
 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** Loader / plugin identity stamped into the client handoff and style tags. */
export const PLUGIN_ID = 'dsh-plugin-market'

/** Browser shell module-table specifiers the client factory may require. */
export const PLATFORM_MODULES: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * Vendored framework libraries that carry no cross-plugin runtime identity:
 * an external client bundle may inline them like ordinary libraries.
 */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/**
 * Inline-safe dsh wire layers (browser-safe values with no shared runtime
 * identity): type/metadata protocol folds the market client may value-import.
 * Everything else under @deepseek-ai/* is a module-table row (external) or a
 * cross-plugin value import the purity gate below rejects.
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-typert-protocol(\/|$)/

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dsh?: { client?: { external?: unknown } }
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as Manifest
}

function escapeSpecifier(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** External patterns for the Node half: this package's production sections. */
function productionExternalPatterns(manifest: Manifest): RegExp[] {
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  return [...names].sort().map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
}

/** Module-table specifiers the client half may require. */
function clientExternals(manifest: Manifest): Set<string> {
  const declared = manifest.dsh?.client?.external
  const extra: string[] = Array.isArray(declared) ? declared.filter((v): v is string => typeof v === 'string') : []
  return new Set([...PLATFORM_MODULES, ...extra])
}

/** Emit one plugin-owned style injector and an optional CSS Modules export. */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${fileId.split(sep).pop()}`)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** Resolve a stylesheet import emitted under lib/types back to its src tree. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolve(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolve(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}

/** Rebase a physical bundle input onto a browser-safe relative source. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physical = resolve(dirname(sourcemapPath), source)
  const root = resolve(process.cwd())
  const rel = physical.startsWith(root) ? physical.slice(root.length + 1) : physical
  return rel.split(sep).join('/')
}

/** Deterministic client build defines (baked, never read at runtime). */
function clientDefines(env: NodeJS.ProcessEnv): Record<string, string> {
  const mode = env.NODE_ENV ?? 'production'
  return {
    'process.env': '{}',
    'process.env.NODE_ENV': JSON.stringify(mode),
    'import.meta.env.MODE': JSON.stringify(mode),
    'import.meta.env': JSON.stringify({ MODE: mode }),
  }
}

/** Chain tsc's emitted maps (consumed lib/types builds) into the bundle. */
function tscSourceMapPlugin() {
  return {
    name: 'dsh-plugin-market-tsc-sourcemap',
    async load(id: string) {
      if (!id.includes(TYPES_MARKER) || !id.endsWith('.js') || !existsSync(`${id}.map`)) return null
      const code = await readFile(id, 'utf8')
      const mapPath = `${id}.map`
      const map = JSON.parse(await readFile(mapPath, 'utf8')) as { sources?: unknown }
      if (!Array.isArray(map.sources) || map.sources.some(source => typeof source !== 'string')) {
        throw new Error(`client sourcemap: ${mapPath} has invalid sources`)
      }
      return { code: code.replace(/\n\/\/# sourceMappingURL=.*\s*$/, ''), map }
    },
  }
}

/** Pure-CSS + CSS Modules inline pipeline (module, text?inline, global). */
function cssPlugins(id: string): unknown[] {
  return [
    {
      name: 'dsh-plugin-market-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(this: { addWatchFile(file: string): void }, virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        const exportEntries = Object.entries(cssExports ?? {})
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        for (const [local, exp] of exportEntries) classMap[local] = exp.name
        return styleInjectionModule(id, fileId, code.toString(), classMap)
      },
    },
    {
      name: 'dsh-plugin-market-css-text-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
        const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
        const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
        return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(this: { addWatchFile(file: string): void }, virtualId: string) {
        if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code } = transform({ filename: fileId, code: source, minify: true })
        return `export default ${JSON.stringify(code.toString())};`
      },
    },
    {
      name: 'dsh-plugin-market-css-global-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(this: { addWatchFile(file: string): void }, virtualId: string) {
        if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code } = transform({ filename: fileId, code: source, minify: true })
        return styleInjectionModule(id, fileId, code.toString())
      },
    },
  ]
}

/** Build-time purity mirror: cross-plugin value imports must be externals. */
function purityPlugin(id: string, externals: Set<string>): unknown {
  return {
    name: 'dsh-plugin-market-client-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (externals.has(source)) return null
      if (VENDORED_LIBRARY.test(source)) return null
      if (INLINE_SAFE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not in the shell module table or ${id}'s`
        + ' dsh.client.external, an inline-safe wire layer, or a vendored library - '
        + 'cross-plugin value imports are forbidden; collaborate through cordis services '
        + '(type-only imports are erased and never reach this gate)',
      )
    },
  }
}

/**
 * Node half: ESM library with production sections external. A single entry
 * keeps the `index.js` output name; an object entry form names each output
 * chunk (`[name].js`), used for sub-entries such as the control row.
 */
export function nodeLibraryConfig(entry: string | Record<string, string>): UserConfig {
  const manifest = readManifest()
  const patterns = productionExternalPatterns(manifest)
  const isProduction = (specifier: string) => patterns.some(pattern => pattern.test(specifier))
  return {
    name: PLUGIN_ID,
    entry,
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    deps: {
      neverBundle: isProduction,
      alwaysBundle: (specifier: string) => !isProduction(specifier),
    },
    outputOptions: {
      // Pin the published name: a .ts entry would otherwise pick .mjs and break
      // the main/exports "./index.js" contract.
      entryFileNames: typeof entry === 'string' ? 'index.js' : '[name].js',
    },
  }
}

/** Browser half: lazy-CJS closure factory consumed by the loader module table. */
export function clientBundleConfig(entry: string): UserConfig {
  const manifest = readManifest()
  const externals = clientExternals(manifest)
  const isRequested = (specifier: string) => externals.has(specifier)
  return {
    name: `${PLUGIN_ID}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    inputOptions: {
      resolve: {
        conditionNames: [
          (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
          'browser', 'import', 'module', 'default',
        ],
      },
    },
    define: clientDefines(process.env),
    plugins: [
      purityPlugin(PLUGIN_ID, externals),
      tscSourceMapPlugin(),
      ...cssPlugins(PLUGIN_ID),
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/** The two artifact configs, with the entry roots selected by the caller. */
export function bundleConfigs(nodeEntry: string, clientEntry: string): UserConfig[] {
  return [nodeLibraryConfig(nodeEntry), clientBundleConfig(clientEntry)]
}