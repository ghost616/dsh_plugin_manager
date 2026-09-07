# dsh-plugin-market

Single-package, distributable **dsh bundle + plugin** for the DeepSeek Harness
(dsh): a Web Plugins-settings "market" tab plus its Host and Control halves,
skeletonized here as a self-contained engineering baseline.

This repository is a single npm package that is simultaneously:

- a **plugin package** exposing Host and browser halves (`dsh.client`,
  `./client` export, `lib/client.js`);
- a **bundle** whose `dsh.bundle.patch` (`cordis.patch.yml`) is the default
  activation layer enabling its own plugin rows after `dsh plugin add`.

Target dsh: `0.1.2-alpha.5` line (`@deepseek-ai/cordis` 4.x, published loader
`@deepseek-ai/cordis-plugin-loader` 1.x). Shared-identity packages are listed
under `peerDependencies` and mirrored into `devDependencies` so the harness
owns exactly one Cordis instance at runtime.

## Layout

| Path | Purpose | Owner |
| --- | --- | --- |
| `package.json` | ESM-only manifest: `exports` (`.`/`./client`/`./types`/`./src/*`/`./package.json`), `dsh.bundle`, `dsh.client`, peer/dev mirror, publish `files` | framework |
| `cordis.patch.yml` | Bundle patch rows: `plugin-market-host` (enabled), `plugin-market-control` / `plugin-market-ui` (declared, disabled until their modules land) | framework |
| `tsconfig.json` + `tsconfig.base.json` + `tsconfig.host.json` + `tsconfig.client.json` | Solution root with **separate Host and Client leaves** (Cordis `Context` declaration merges never share one Program); tsc emits `lib/types` | framework |
| `tsdown.config.ts` / `tsdown.prepare.config.ts` / `tsdown.shared.ts` | Self-contained tsdown replication of the dsh artifact contracts (Node ESM externalizing production deps; browser lazy-CJS closure factory with `window.__ModuleLoader__.load`, baked `NODE_ENV`, inlined CSS) | framework |
| `src/index.ts` | Host loader entry - `plugin-market-host` placeholder (`name`/`inject`/`apply`) | framework placeholder; plugin-market-host later |
| `src/client/index.ts` | Browser-half registration point (placeholder; built to `lib/client.js`) | framework placeholder; plugin-market-ui later |
| `src/types.ts` | Cross-face shared types (`import type` only) | framework |
| `scripts/install-profile.mjs` | Idempotent profile self-load recipe (junction/copy + patch rows) | framework |
| `scripts/verify-load.mjs` | Demo verification: real Loader activation + artifact checks | framework |
| `tests/` | Test home (vitest specs land with the business modules) | all modules |

Entry ownership contract (row ids are stable):

| Row id | Entry | Status |
| --- | --- | --- |
| `plugin-market-host` | package main (`lib/index.js`, `src/index.ts`) | placeholder |
| `plugin-market-control` | planned `./control` (`lib/control.js`) | disabled until plugin-control-service lands |
| `plugin-market-ui` | planned `./ui` (Host no-op; browser half via `./client`) | disabled until plugin-market-ui lands |

## Build

Requires Node `^22.19.0 || >=24` and pnpm.

```sh
pnpm install
pnpm build        # tsc -b (types to lib/types) && tsdown (lib/index.js, lib/client.js)
pnpm verify       # demo profile + real Loader activation of the placeholder
```

- `tsc -b` type-checks both leaves and emits `lib/types`.
- `tsdown` bundles the tsc emission: the Node half (`lib/index.js`) keeps
  production-section specifiers external; the browser half (`lib/client.js`)
  is the lazy-CJS closure factory whose externals resolve through the loader
  module table (react, cordis, … platform specifiers plus anything declared in
  `dsh.client.external`), with everything else inlined.
- Client code never value-imports another plugin: the tsdown purity gate
  rejects cross-plugin `@deepseek-ai/*` value imports (types are erased).

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
2. appends the managed rows to the profile's `cordis.patch.yml`, resolving
   relative to the profile directory:

   ```yaml
   - insert:
       - id: plugin-market-host
         name: './plugins/dsh-plugin-market/lib/index.js'
       - id: plugin-market-control
         name: './plugins/dsh-plugin-market/lib/control.js'
         disabled: true
       - id: plugin-market-ui
         name: './plugins/dsh-plugin-market/lib/ui.js'
         disabled: true
   ```

   plugin-market-control/ui stay disabled until their entries ship, so the
   layer is loadable from day one.

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

- `framework` owns the root scaffolding only; business logic lives with the
  plugin-market-host / plugin-control-service / plugin-market-ui modules under
  `src` and `tests/`, each of which consumes this build chain unchanged.
- Cross-module collaboration goes through cordis services or loader rows;
  browser `inject` is a pure data contract.
- See the workspace module specs and code conventions for the full contract
  (function/service plugin shapes, context keys, event naming, client bundle
  purity, remote wire rules, test patterns).