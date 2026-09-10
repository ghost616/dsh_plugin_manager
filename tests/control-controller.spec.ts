import { describe, expect, it } from 'vitest'
import { MarketControlError, REMOVE_CONFIRM_TTL_MS } from '../src/host/control/controller.ts'
import { key, testbed } from './support/control-testbed.ts'

describe('MarketPluginController record-driven lifecycle', () => {
  it('rebuild registers records in key order with disabled stays disabled and enabled loads', async () => {
    const bed = testbed()
    bed.records.seed('gh-zeta', { enabled: true, localDirName: 'zeta', entry: 'plugin.mjs' })
    bed.records.seed('gh-alpha', { enabled: false, localDirName: 'alpha', entry: 'plugin.mjs' })

    await bed.controller().rebuild()

    expect(bed.loader.created).toEqual(['gh-alpha', 'gh-zeta'])
    expect(bed.loader.view(key('gh-alpha'))).toMatchObject({
      id: 'gh-alpha',
      moduleName: 'file:///repo/alpha/plugin.mjs',
      disabled: true,
      phase: null,
    })
    expect(bed.loader.view(key('gh-zeta'))).toMatchObject({
      id: 'gh-zeta',
      disabled: false,
      phase: 'active',
    })
  })

  it('setEnabled off→on creates and loads the row; on→off disables it', async () => {
    const bed = testbed()
    const record = bed.records.seed('gh-demo', { enabled: false, localDirName: 'demo', entry: 'plugin.mjs' })
    const controller = bed.controller()
    await controller.rebuild()

    const enabled = await controller.setEnabled(record.key, true)
    expect(enabled.enabled).toBe(true)
    expect((await bed.records.get(record.key))?.enabled).toBe(true)
    expect(bed.loader.view(record.key)).toMatchObject({ disabled: false, phase: 'active' })

    const disabled = await controller.setEnabled(record.key, false)
    expect(disabled.enabled).toBe(false)
    expect(bed.loader.view(record.key)).toMatchObject({ disabled: true, phase: null })
  })

  it('keeps the record enabled and reports lastError when a load fails', async () => {
    const bed = testbed()
    const record = bed.records.seed('gh-broken', {
      enabled: false,
      localDirName: 'broken',
      entry: '__broken__.mjs',
    })
    const controller = bed.controller()

    await expect(controller.setEnabled(record.key, true)).rejects.toMatchObject({
      code: 'market/load-failed',
    })

    expect((await bed.records.get(record.key))?.enabled).toBe(true)
    expect(bed.loader.view(record.key)).toBeUndefined()
    const list = await controller.list()
    const view = list.entries[0]
    expect(view?.runtime.lastError).toContain('boom')
    expect(view?.runtime.moduleName).toBeNull()

    // Recovery: disable is always possible, keeping sources and records.
    const disabled = await controller.setEnabled(record.key, false)
    expect(disabled.enabled).toBe(false)
    expect((await controller.list()).entries[0]?.runtime.lastError).toBeNull()
  })

  it('restart rebuild recreates rows from records with a fresh loader', async () => {
    const bed = testbed()
    bed.records.seed('gh-on', { enabled: true, localDirName: 'on', entry: 'plugin.mjs' })
    bed.records.seed('gh-off', { enabled: false, localDirName: 'off', entry: 'plugin.mjs' })
    await bed.controller().rebuild()
    // Simulate a process restart: a fresh controller over the same records
    // (same "disk") but an empty loader tree.
    const second = testbed()
    second.records.seed('gh-on', {
      enabled: true,
      localDirName: 'on',
      entry: 'plugin.mjs',
    })
    second.records.seed('gh-off', {
      enabled: false,
      localDirName: 'off',
      entry: 'plugin.mjs',
    })
    await second.controller().rebuild()

    expect(second.loader.view(key('gh-on'))).toMatchObject({ disabled: false, phase: 'active' })
    expect(second.loader.view(key('gh-off'))).toMatchObject({ disabled: true, phase: null })
  })

  it('list merges record and live loader projection without a second cache', async () => {
    const bed = testbed()
    const record = bed.records.seed('gh-list', { enabled: false, localDirName: 'list', entry: 'plugin.mjs' })
    const controller = bed.controller()
    await controller.rebuild()
    const before = await controller.list()
    expect(before.entries[0]).toMatchObject({
      key: 'gh-list',
      runtime: { moduleName: 'file:///repo/list/plugin.mjs', disabled: true, phase: null },
    })
    expect(before.entries[0]?.record).toEqual(record)

    await controller.setEnabled(record.key, true)
    const after = await controller.list()
    expect(after.entries[0]?.runtime).toMatchObject({ disabled: false, phase: 'active' })
  })

  it('removal needs requestRemove, a matching token, and rejects when expired', async () => {
    let nowMs = 1_000
    const bed = testbed({ now: () => new Date(nowMs) })
    const record = bed.records.seed('gh-rem', { enabled: true, localDirName: 'rem', entry: 'plugin.mjs' })
    const controller = bed.controller()
    await controller.rebuild()

    await expect(controller.confirmRemove(record.key, 'nope')).rejects.toMatchObject({
      code: 'market/confirm-required',
    })

    const request = await controller.requestRemove(record.key)
    expect(request.key).toBe(record.key)
    expect(new Date(request.expiresAt).getTime()).toBe(nowMs + REMOVE_CONFIRM_TTL_MS)

    await expect(controller.confirmRemove(record.key, 'wrong')).rejects.toMatchObject({
      code: 'market/confirm-invalid',
    })

    const outcome = await controller.confirmRemove(record.key, request.token)
    expect(outcome).toEqual({
      key: record.key,
      removedEntry: true,
      removedDirectory: true,
      removedRecord: true,
      directory: '/repo/rem',
    })
    expect(bed.loader.view(record.key)).toBeUndefined()
    expect(await bed.records.get(record.key)).toBeNull()
    expect(bed.remover.removed).toEqual(['/repo/rem'])

    // Tokens are single-use: the record is gone, so a retry cannot confirm.
    await expect(controller.confirmRemove(record.key, request.token)).rejects.toMatchObject({
      code: 'record/not-found',
    })

    // Expiry path.
    const second = bed.records.seed('gh-exp', { enabled: false, localDirName: 'exp', entry: 'plugin.mjs' })
    await controller.requestRemove(second.key)
    nowMs += REMOVE_CONFIRM_TTL_MS + 1
    await expect(
      controller.confirmRemove(second.key, 'any'),
    ).rejects.toMatchObject({ code: 'market/confirm-expired' })
  })

  it('refuses to manage protected keys and self modules', async () => {
    const bed = testbed()
    const controller = bed.controller()
    // A protected self row id used as a record key is never manageable.
    const selfRow = bed.records.seed('plugin-market-host', { enabled: false })
    await expect(controller.setEnabled(selfRow.key, true)).rejects.toMatchObject({
      code: 'market/protected',
    })
    await expect(controller.requestRemove(selfRow.key)).rejects.toMatchObject({
      code: 'market/protected',
    })
    // A record whose entry module points inside the manager itself is refused.
    const selfModule = bed.records.seed('gh-selfdir', {
      enabled: false,
      localDirName: '__self__dir',
      entry: 'plugin.mjs',
    })
    await expect(controller.setEnabled(selfModule.key, true)).rejects.toMatchObject({
      code: 'market/protected',
    })
  })

  it('dispose removes every owned loader row', async () => {
    const bed = testbed()
    bed.records.seed('gh-a', { enabled: true, localDirName: 'a', entry: 'plugin.mjs' })
    bed.records.seed('gh-b', { enabled: true, localDirName: 'b', entry: 'plugin.mjs' })
    const controller = bed.controller()
    await controller.rebuild()
    expect(bed.loader.entries()).toHaveLength(2)
    await controller.dispose()
    expect(bed.loader.entries()).toHaveLength(0)
  })

  it('a failed rebuild row captures the error and keeps going', async () => {
    const bed = testbed()
    bed.records.seed('gh-good', { enabled: true, localDirName: 'good', entry: 'plugin.mjs' })
    bed.records.seed('gh-bad', { enabled: true, localDirName: 'bad', entry: '__broken__.mjs' })
    bed.records.seed('gh-later', { enabled: true, localDirName: 'later', entry: 'plugin.mjs' })
    const controller = bed.controller()
    await controller.rebuild()

    expect(bed.loader.view(key('gh-good'))?.phase).toBe('active')
    expect(bed.loader.view(key('gh-bad'))).toBeUndefined()
    expect(bed.loader.view(key('gh-later'))?.phase).toBe('active')
    const bad = (await controller.list()).entries.find(entry => entry.key === 'gh-bad')
    expect(bad?.runtime.lastError).toContain('boom')
  })
})

describe('MarketPluginController load gate (classification / entry)', () => {
  it('reports loadable per record: only a plugin classification with an entry can load', async () => {
    const bed = testbed()
    bed.records.seed('gh-plugin', { enabled: false, localDirName: 'plugin', entry: 'plugin.mjs' })
    bed.records.seed('gh-legacy', { enabled: false, localDirName: 'legacy', entry: 'plugin.mjs', classification: 'plugin' })
    bed.records.seed('gh-noentry', { enabled: false, localDirName: 'noentry', entry: null, classification: 'plugin' })
    bed.records.seed('gh-skills', { enabled: false, localDirName: 'skills', entry: null, classification: 'skills' })
    bed.records.seed('gh-other', { enabled: false, localDirName: 'other', entry: null, classification: 'other' })

    const list = await bed.controller().list()
    expect(list.entries.map(entry => [entry.key, entry.loadable])).toEqual([
      ['gh-legacy', true],
      ['gh-noentry', false],
      ['gh-other', false],
      ['gh-plugin', true],
      ['gh-skills', false],
    ])
  })

  it('refuses to enable a skills/other checkout with market/not-loadable and stays manageable', async () => {
    const bed = testbed()
    const skills = bed.records.seed('gh-skills-pack', {
      enabled: false,
      localDirName: 'skills-pack',
      entry: null,
      classification: 'skills',
    })
    const other = bed.records.seed('gh-docs', {
      enabled: false,
      localDirName: 'docs',
      entry: null,
      classification: 'other',
    })
    const controller = bed.controller()
    await controller.rebuild()

    const skillsError = await controller.setEnabled(skills.key, true).catch((error: unknown) => error)
    expect(skillsError).toBeInstanceOf(MarketControlError)
    expect(skillsError).toMatchObject({
      code: 'market/not-loadable',
      details: { key: 'gh-skills-pack', reason: 'classification' },
    })
    expect((skillsError as Error).message).toContain('skills')
    expect((await controller.setEnabled(other.key, true).catch((error: unknown) => error))).toMatchObject({
      code: 'market/not-loadable',
      details: { key: 'gh-docs', reason: 'classification' },
    })

    // Nothing was persisted or loaded: the gate fires before any side effect.
    expect((await bed.records.get(skills.key))?.enabled).toBe(false)
    expect((await bed.records.get(other.key))?.enabled).toBe(false)
    expect(bed.loader.view(skills.key)).toMatchObject({ disabled: true, phase: null })

    // Disabling stays allowed (idempotent no-op here), as does removal.
    expect((await controller.setEnabled(other.key, false)).enabled).toBe(false)
    const request = await controller.requestRemove(skills.key)
    expect(request.key).toBe(skills.key)
  })

  it('refuses a plugin-classified record filed without an entry (market/not-loadable, reason entry)', async () => {
    const bed = testbed()
    const record = bed.records.seed('gh-build-required', {
      enabled: false,
      localDirName: 'build-required',
      entry: null,
      classification: 'plugin',
    })
    const caught = await bed.controller().setEnabled(record.key, true).catch((error: unknown) => error)
    expect(caught).toMatchObject({
      code: 'market/not-loadable',
      details: { key: 'gh-build-required', reason: 'entry' },
    })
    expect((caught as Error).message).toContain('no plugin entry')
  })

  it('keeps enabling a plain plugin record (no classification tag) working', async () => {
    const bed = testbed()
    const record = bed.records.seed('gh-plain', { enabled: false, localDirName: 'plain', entry: 'plugin.mjs' })
    const controller = bed.controller()
    const enabled = await controller.setEnabled(record.key, true)
    expect(enabled.enabled).toBe(true)
    expect(bed.loader.view(record.key)).toMatchObject({ disabled: false, phase: 'active' })
    expect((await controller.list()).entries[0]).toMatchObject({ key: 'gh-plain', loadable: true })
  })

  it('never builds an ENABLED row for a non-loadable record whose flag was hand-edited', async () => {
    const bed = testbed()
    // A hand-edited records file can claim `enabled: true`; the row builder is
    // the second line of defence and must not import a missing entry.
    const skills = bed.records.seed('gh-skills-pack', {
      enabled: true,
      localDirName: 'skills-pack',
      entry: null,
      classification: 'skills',
    })
    const noEntry = bed.records.seed('gh-noentry', {
      enabled: true,
      localDirName: 'noentry',
      entry: null,
      classification: 'plugin',
    })
    const controller = bed.controller()
    await controller.rebuild()

    expect(bed.loader.view(skills.key)).toMatchObject({ disabled: true, phase: null })
    expect(bed.loader.view(noEntry.key)).toMatchObject({ disabled: true, phase: null })
    // The unreachable flag is written back so the record agrees with the row.
    expect((await bed.records.get(skills.key))?.enabled).toBe(false)
    expect((await bed.records.get(noEntry.key))?.enabled).toBe(false)

    const entries = (await controller.list()).entries
    expect(entries.every(entry => entry.loadable === false)).toBe(true)
    expect(entries.every(entry => entry.runtime.disabled === true)).toBe(true)
    // The reason is reported per row instead of silently dropping the state.
    expect(entries[0]?.runtime.lastError).toContain('cannot be loaded')
  })

  it('keeps an enabled row of a loadable record (the guard only targets non-loadable ones)', async () => {
    const bed = testbed()
    const record = bed.records.seed('gh-on', { enabled: true, localDirName: 'on', entry: 'plugin.mjs' })
    await bed.controller().rebuild()
    expect(bed.loader.view(record.key)).toMatchObject({ disabled: false, phase: 'active' })
    expect((await bed.records.get(record.key))?.enabled).toBe(true)
    expect((await bed.controller().list()).entries[0]).toMatchObject({
      loadable: true,
      runtime: { disabled: false, lastError: null },
    })
  })
})

describe('MarketControlError carries the wire shape', () => {
  it('exposes code and details for channel mapping', () => {
    const error = new MarketControlError(
      'market/confirm-expired',
      'expired',
      { key: key('gh-x') },
    )
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('market/confirm-expired')
    expect(error.details).toEqual({ key: 'gh-x' })
  })
})