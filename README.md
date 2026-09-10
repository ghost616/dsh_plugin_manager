# dsh-plugin-market

Single-package, distributable **dsh bundle + plugin** for the DeepSeek Harness
(dsh): a Web Plugins-settings "market" tab plus its Host and Control halves,
converged onto a **single loader row** whose package main composes all Host
behavior.

This repository is a single npm package that is simultaneously:

- a **plugin package** exposing Host and browser halves (`dsh.client`,
  `./client` export, `lib/client.js`);
- a **bundle** whose `dsh.bundle.patch` (`cordis.patch.yml`) is the default
  activation layer enabling its own plugin row after `dsh plugin add`.

Target dsh: `0.1.2-alpha.5` line (`@deepseek-ai/cordis` 4.x, published loader
`@deepseek-ai/cordis-plugin-loader` 1.x). Shared-identity packages are listed
under `peerDependencies` and mirrored into `devDependencies` so the harness
owns exactly one Cordis instance at runtime.

## Layout

| Path | Purpose | Owner |
| --- | --- | --- |
| `package.json` | ESM-only manifest: `exports` (`.`/`./client`/`./types`/`./control`/`./src/*`/`./package.json`), `dsh.bundle`, `dsh.client`, peer/dev mirror, publish `files` | framework |
| `cordis.patch.yml` | Bundle patch layer: exactly one loader row, `plugin-market-host` | framework |
| `tsconfig.json` + `tsconfig.base.json` + `tsconfig.host.json` + `tsconfig.client.json` | Solution root with **separate Host and Client leaves** (Cordis `Context` declaration merges never share one Program); tsc emits `lib/types` | framework |
| `tsdown.config.ts` / `tsdown.prepare.config.ts` / `tsdown.shared.ts` | Self-contained tsdown replication of the dsh artifact contracts (Node ESM externalizing production deps; browser lazy-CJS closure factory with `window.__ModuleLoader__.load`, baked `NODE_ENV`, inlined CSS) | framework |
| `src/index.ts` | Host package main / single-row composer: normalizes Config, opens the repository (`marketRepository` service), activates the embedded control in the same context | framework |
| `src/host/market/` | plugin-market-host business: repository validation/layout, records store v1 (enabled/trusted/trustedAt record fields), shared-harness linking - an independent manifest/TrustGate surface is planned, not yet shipped | plugin-market-host |
| `src/host/control/` | plugin-control-service business: record-driven controller, loader adapter, protection, Remote gateway + web channel (composable activation, not a row) | plugin-control-service |
| `src/client/` | Browser half (settings tab, locales, channel) built to `lib/client.js`; delivered via `dsh.client` | plugin-market-ui |
| `src/types.ts` | Cross-face shared types (`import type` only) | framework |
| `scripts/install-profile.mjs` | Idempotent profile self-load recipe (junction/copy + the single patch row) | framework |
| `scripts/verify-load.mjs` | Demo verification: real Loader activation of the single row + artifact checks | framework |
| `scripts/check-encoding.mjs` | Encoding/whitespace pre-flight over tracked text files (invalid UTF-8, C1, cp1252 mojibake, U+FFFD, `git diff --check`) | framework |
| `tests/` | Vitest suites for all modules (business tests live with their module owners) | all modules |
| `vitest.config.ts` + `tsconfig.test.json` | Test gate: vitest keeps its defaults (only `.lizhu_env/**` is excluded from collection) and `tsc -p tsconfig.test.json --noEmit` type-checks `tests/**` + the root configs | framework |
| `.lizhu_env/` | Local test environment (Playwright specs + harness config + artifacts): **not committed at all**; vitest excludes it from collection | framework |

### Row contract (single-row convergence)

| Row id | Entry | What activates |
| --- | --- | --- |
| `plugin-market-host` | package main (`lib/index.js` from `src/index.ts`) | Config normalization + repository open + `marketRepository` service + the **embedded** market control (`ctx.plugin`) in the same context; the browser half is delivered via `dsh.client` and needs no row |

There are deliberately **no** `plugin-market-control` / `plugin-market-ui`
loader rows: the control is a composable activation (`ctx.plugin(marketControlPlugin)`,
still exported as `./control` for hosts that embed it directly) and the UI is a
client half. One row means one package, one client-bundle source, and one
lifecycle: an unconfigured market stays idle without failing, a configured
`repositoryPath` that fails directory validation fails the row loudly at boot,
and teardown of the row tears down the repository service, the controller and
any loader rows it created.

## Build

Requires Node `^22.19.0 || >=24` and pnpm.

```sh
pnpm install
pnpm build        # tsc -b (types to lib/types) && tsdown (lib/index.js, lib/client.js)
pnpm verify       # demo profile + real single-row Loader activation
pnpm test         # check-encoding && selftest && tsc -b && tsc -p tsconfig.test.json --noEmit && vitest run
pnpm check:encoding   # the pre-flight alone (also the first step of `test`)
pnpm check:encoding:selftest   # fixture-driven self-test of the pre-flight (second step of `test`)
```

- `node scripts/check-encoding.mjs` runs first because it is the cheapest gate
  (a text scan of the tracked corpus) and it catches a defect class no compiler
  can see: invalid UTF-8, C1 control characters, cp1252 mojibake and `U+FFFD`,
  plus `git diff --check`-style whitespace. Warnings (UTF-8 BOM, blank line at
  end of file) are printed but never fail the run.
- `node scripts/check-encoding.mjs --self-test` (also `pnpm
  check:encoding:selftest`) creates synthetic fixtures in a temp directory and
  asserts every judgement and the exit code: clean UTF-8 with non-ASCII text
  passes, invalid bytes / C1 / mojibake / `U+FFFD` fail, BOM and blank-at-eof
  only warn, NUL-bearing and empty files are skipped, and the `git diff --check`
  parser ignores diff-content lines. It never writes inside the repository and
  cleans up after itself. It is the second step of `pnpm test`, so the gate can
  never silently rot: editing the checker without updating its expectations fails
  the same run.
- `tsc -b` type-checks both leaves and emits `lib/types`.
- `tsc -p tsconfig.test.json --noEmit` type-checks `tests/**` (which spans both
  faces, so that project has DOM + React JSX and node ambient types at once)
  plus the root build/test configs (`vitest.config.ts`, `tsdown*.ts`); `vitest`
  itself never type-checks, so this step is what keeps the specs honest about
  the wire types (branded keys, `exactOptionalPropertyTypes` shapes) and keeps
  the configs from rotting.
- `tsdown` bundles the tsc emission: the Node half (`lib/index.js`) keeps
  production-section specifiers external; the browser half (`lib/client.js`)
  is the lazy-CJS closure factory whose externals resolve through the loader
  module table (react, cordis, platform specifiers plus anything declared in
  `dsh.client.external`), with everything else inlined. The composable control
  sub-entry is additionally emitted as `lib/control.js`.
- Client code never value-imports another plugin: the tsdown purity gate
  rejects cross-plugin `@deepseek-ai/*` value imports (types are erased).

### Local test environment (`.lizhu_env/`)

`.lizhu_env/` is a **local test-environment directory that is not committed at
all** — Playwright specs, harness config (`playwright.config.ts`,
`vite.config.mts`, `main.tsx`, `index.html`), package manifests and run
artifacts alike. `.gitignore` ignores the directory wholesale (`.lizhu_env/`),
so nothing inside it is version-controlled; `git rm -r --cached .lizhu_env` was
run once to drop the files that had been added, keeping the working tree
untouched.

**This is a deliberate decision, not an oversight.** The browser specs are a
machine-local verification tool: their value is the *conclusion* they produce
("the layout holds in a real Chromium"), and that conclusion is recorded in the
module change history rather than by committing the harness. The specs are also
not portable as-is (they depend on a local Chromium install, local
`node_modules` and a local dev-server port), so tracking them would add a second,
silently rotting copy of component markup without giving CI anything runnable.
The single-writer rule below is the alternative discipline: machine runs are
recorded where they are read (the module history), not where they cannot run.
Do not "fix" this by moving a spec under `tests/` or by re-adding `.lizhu_env/`
to the index.

`vitest.config.ts` keeps excluding `.lizhu_env/**` from collection. Being
ignored by git does not make a directory invisible to the unit runner — vitest
walks the filesystem, not the index — so without that `exclude` the browser
specs under `.lizhu_env/e2e/tests/` would be collected and the run would fail
with `Playwright Test did not expect test.beforeEach() to be called here` (their
`@playwright/test` copy has nothing to do with anything this package resolves).
The two settings therefore do different jobs and both stay: `.gitignore` keeps
the local environment out of the repository, and the vitest `exclude` keeps it
out of the test run. `tsconfig.test.json` covers `tests/**` and the root configs
only, so those specs are not type-checked either.

Run them from `.lizhu_env/e2e/` itself (`npm install`,
`npx playwright install chromium`, then `npx playwright test`); each spec's
header documents its own setup. Because the directory is local-only, treat it as
disposable: nothing in it can be shared through the repository.

## Process conventions

- **A spec file has exactly one writer.** The module that owns a file is the only
  one that edits it; when a change genuinely spans modules, the owning module
  executes it or the plan states the ownership explicitly before the work starts.
  This exists because cross-module edits have already caused real damage here
  (a module rewrote another module's spec, and a PowerShell round-trip through a
  spec file silently re-encoded it).
- **Run the encoding/whitespace gate before committing.** It is the first step of
  `npm test` (`node scripts/check-encoding.mjs`); run it standalone with
  `npm run check:encoding`. It scans tracked text files for invalid UTF-8, C1
  control characters, cp1252 mojibake and the `U+FFFD` replacement character,
  plus `git diff --check`-style whitespace violations. When it reports a file
  outside your module, report it — do not fix it.
- **When editing text files, never let a tool re-encode them.** Write with the
  editor/file tools, and if a shell is unavoidable read and write raw bytes with
  an explicit UTF-8 (no BOM) encoding. This is the setup for the accident the
  gate above exists to catch.
- **Plans and specs must match the actual delta.** A plan states what will
  change and the module spec is updated to what did change; a summary that claims
  more (or less) than the diff is a defect to fix, not a wording detail.

## Profile self-load (development recipe)

To load this checkout's built artifacts inside a dsh profile without
publishing or git-installing the package:

```sh
pnpm build
node scripts/install-profile.mjs "$DSH_HOME/profiles/<name>"
```

The script (idempotent; safe to re-run):

1. creates `plugins/dsh-plugin-market` in the profile - a **junction** to this
   repository (or a recursive copy with `--mode copy`); the link is skipped
   when it already points at this repository;
2. appends the single managed row to the profile's `cordis.patch.yml`,
   resolving relative to the profile directory:

   ```yaml
   - insert:
       - id: plugin-market-host
         name: './plugins/dsh-plugin-market/lib/index.js'
   ```

   One row is all the package needs: the main entry composes the repository
   service and activates the embedded control in the same context, and the
   browser half is provided with the package through its `dsh.client`
   declaration. When the profile should manage a repository, add
   `repositoryPath` to the row's config.

Undo with `node scripts/install-profile.mjs "$DSH_HOME/profiles/<name>" --uninstall`.

> The dsh profile patch layers apply on boot; edit a live profile only when a
> restart (or the profile's live patch reload) is acceptable. Do not point the
> script at a profile another dsh process is actively booted from.

The script and verification never modify the dsh implementation checkout; the
loader used by `pnpm verify` is the published
`@deepseek-ai/cordis-plugin-loader` from this package's devDependencies.

## Installing the package for real users

As a **bundle+plugin package**, users install it into a profile with:

```sh
dsh plugin --profile <name> add github:you/dsh-plugin-market#<sha>
```

A git install fetches sources, not artifacts, so two things must hold:

- **`prepare` builds the entries self-contained** - `tsdown --config
  tsdown.prepare.config.ts` transpiles `src/` directly (no project
  references, no type checking). Run `pnpm build` before publishing.
- **The user allowlists the build** (pnpm >= 10): copy the package key pnpm
  prints into the profile's `pnpm-workspace.yaml`:

  ```yaml
  allowBuilds:
    dsh-plugin-market: true
  ```

  and re-run the `add`. Only install sources you trust, and pin a commit.

Prebuilt distribution needs no allowance: publish to npm (`pnpm publish`
runs `prepare`; run `pnpm build` first so `lib/types` ships for consumers) or
hand out a tarball from `pnpm pack`.

## Boundaries and conventions

- `framework` owns the root scaffolding, the single-row contract and the
  profile recipe; business logic lives with the plugin-market-host /
  plugin-control-service / plugin-market-ui modules under `src` and `tests/`,
  each of which consumes this build chain unchanged.
- Cross-module collaboration goes through cordis services; the embedded
  control resolves `marketRepository`/`loader` from the composing context
  chain, and the browser `inject` is a pure data contract.
- See the workspace module specs and code conventions for the full contract
  (function/service plugin shapes, context keys, event naming, client bundle
  purity, remote wire rules, test patterns).