/** Adding and removing watched repositories: `Settings.save` creating an instance, `Settings.remove`, the DELETE route and the history of both. */
import { afterEach, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { policyVersion } from '../src/policy.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { popoKind } from '../src/sources/popo.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined; vi.restoreAllMocks() })

const WIDGETS = 'github:acme~widgets'
const GADGETS = 'github:acme~gadgets'
const instance = (repository: string) => ({ enabled: true, config: { repository } })

it('creates an instance at revision 0, even after an earlier one was removed, and conflicts only when it was stored first', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  vi.spyOn(Setup.prototype, 'checkAccounts').mockResolvedValue(undefined)
  expect(Object.keys(store.settings().sources)).toContain(WIDGETS)
  const created = await settings.save(`source:${GADGETS}`, instance('acme/gadgets'), 0, 'panel')
  expect(created).toMatchObject({ saved: true, restarting: true })
  expect(store.settings().sources[GADGETS]).toMatchObject({ enabled: true, config: { repository: 'acme/gadgets' } })
  // The block's revision moved on, yet a removed instance is created again at revision 0.
  const revision = store.blockRevision(`source:${GADGETS}`)
  expect(revision).toBeGreaterThan(0)
  await settings.remove(`source:${GADGETS}`, revision, 'panel')
  await settings.save(`source:${GADGETS}`, instance('acme/gadgets'), 0, 'panel')
  expect(store.settings().sources[GADGETS]).toBeDefined()
  // An instance that is stored already conflicts with a second creation.
  await expect(settings.save(`source:${GADGETS}`, instance('acme/gadgets'), 0, 'panel')).rejects.toThrow(SettingsConflict)
})

it('removes an instance with its Policy part, restarts, and refuses stale, unknown, account and non-panel removals', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  vi.spyOn(Setup.prototype, 'checkAccounts').mockResolvedValue(undefined)
  const restart = vi.spyOn(Setup.prototype, 'restart').mockImplementation(() => {})
  const block = `source:${WIDGETS}`
  store.saveSettings({ ...store.settings(), policy: { ...store.settings().policy,
    sources: { ...store.settings().policy.sources, [WIDGETS]: { allowed: [{ id: 'alice' }] } } } })
  const revision = store.blockRevision(block)
  await expect(settings.remove(block, revision + 1, 'panel')).rejects.toThrow(SettingsConflict)
  await expect(settings.remove(block, revision, 'tool')).rejects.toThrow(new UserError('panelOnlyAccounts'))
  // The account of a multi-instance Source and an instance that was never stored are not removable.
  await expect(settings.remove('source:github', store.blockRevision('source:github'), 'panel')).rejects.toThrow(UserError)
  await expect(settings.remove(`source:${GADGETS}`, 0, 'panel')).rejects.toThrow(new UserError('unknownBlock', { block: `source:${GADGETS}` }))
  await expect(settings.remove('policy', 0, 'panel')).rejects.toThrow(UserError)
  expect(store.settings().sources[WIDGETS]).toBeDefined()
  const removed = await settings.remove(block, revision, 'panel')
  expect(removed).toMatchObject({ saved: true, restarting: true, revision: revision + 1 })
  expect(restart).toHaveBeenCalledTimes(1)
  expect(store.settings().sources[WIDGETS]).toBeUndefined()
  expect(store.settings().policy.sources[WIDGETS]).toBeUndefined()
  expect(store.settings().sources.github).toBeDefined()
  // The removed instance leaves the registry, the account stays.
  expect(h.runtime.sources.instances(store.settings()).map(item => item.id)).not.toContain(WIDGETS)
  // A repeated removal finds nothing stored.
  await expect(settings.remove(block, revision + 1, 'panel')).rejects.toThrow(UserError)
})

it('serves DELETE settings/:block for a stored instance, answers a stale revision with 409, and refuses an account', async () => {
  h = await startRuntime()
  const { store } = h.runtime
  vi.spyOn(Setup.prototype, 'restart').mockImplementation(() => {})
  const block = `source:${WIDGETS}`
  const revision = store.blockRevision(block)
  expect(await h.api('DELETE', `settings/${block}`, { revision: revision + 1 })).toMatchObject({ status: 409 })
  expect(await h.api('DELETE', `settings/${block}`, {})).toMatchObject({ status: 400 })
  // The account and a block that is no instance are unknown to removal.
  expect(await h.api('DELETE', 'settings/source:github', { revision: 0 })).toMatchObject({ status: 404, body: { code: 'unknownBlock' } })
  expect(await h.api('DELETE', 'settings/policy', { revision: 0 })).toMatchObject({ status: 400 })
  expect(await h.api('DELETE', `settings/${block}`, { revision })).toMatchObject({ status: 200, body: { saved: true, restarting: true } })
  expect(store.settings().sources[WIDGETS]).toBeUndefined()
  expect(await h.api('DELETE', `settings/${block}`, { revision })).toMatchObject({ status: 404 })
})

it('records an added and a removed instance in the history as one change each', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  vi.spyOn(Setup.prototype, 'checkAccounts').mockResolvedValue(undefined)
  vi.spyOn(Setup.prototype, 'restart').mockImplementation(() => {})
  await settings.save(`source:${GADGETS}`, instance('acme/gadgets'), 0, 'panel')
  await settings.remove(`source:${GADGETS}`, store.blockRevision(`source:${GADGETS}`), 'panel')
  const history = policyHistory(store, h.runtime.sources, policyVersion(store.settings()))
  const changes = JSON.stringify(history)
  expect(changes).toContain('"code":"sourceAdded"')
  expect(changes).toContain('"code":"sourceRemoved"')
  expect(changes).toContain(GADGETS)
})

/** Stores `sources` on top of the running host's settings: the fixture saves its own sources after seeding, so tests set theirs afterwards. */
const store = (host: Host, sources: Record<string, { enabled: boolean; config: Record<string, unknown> }>) => {
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, ...sources } })
}

it.each([
  ['github', 'github:acme~widgets', 'github:acme~gadgets', 'acme/gadgets'],
  ['gitlab', 'gitlab:apc~server', 'gitlab:apc~client', 'apc/client'],
])('%s: turns every instance off with its account, and refuses to turn one on while the account is off', async (kind, first, second, repository) => {
  h = await startRuntime()
  h.runtime.sources.register(gitlabKind)
  store(h, kind === 'gitlab'
    ? { gitlab: { enabled: true, config: { host: 'gitlab.acme.test', cli: '/bin/sh' } }, [first]: { enabled: true, config: { repository: 'apc/server' } },
      [second]: { enabled: true, config: { repository } } }
    : { [second]: { enabled: true, config: { repository } } })
  const { settings, store: saved, sources } = h.runtime
  vi.spyOn(Setup.prototype, 'checkAccounts').mockResolvedValue(undefined)
  vi.spyOn(Setup.prototype, 'restart').mockImplementation(() => {})
  const enabled = () => Object.fromEntries(Object.entries(saved.settings().sources).filter(([id]) => id.startsWith(kind)).map(([id, value]) => [id, value.enabled]))
  expect(enabled()).toEqual({ [kind]: true, [first]: true, [second]: true })
  const revisions = () => [kind, first, second].map(id => saved.blockRevision(`source:${id}`))
  const before = revisions()
  // Turning the account off turns every repository or project under it off in the same save, and moves their blocks to new revisions
  // so a draft or a save made against the old ones conflicts instead of switching them back on.
  await settings.save(`source:${kind}`, { ...saved.settings().sources[kind]!, enabled: false }, before[0]!, 'panel')
  expect(enabled()).toEqual({ [kind]: false, [first]: false, [second]: false })
  expect(revisions().map((revision, index) => revision - before[index]!)).toEqual([1, 1, 1])
  expect(sources.instance(first)).toMatchObject({ enabled: false })
  expect(sources.instanceIdFor(undefined, kind)).toBe(first)
  const off = saved.settings().sources[second]!
  await expect(settings.save(`source:${second}`, { ...off, enabled: true }, before[2]!, 'panel')).rejects.toThrow(SettingsConflict)
  // No repository or project is switched on, nor added switched on, while the account is off.
  await expect(settings.save(`source:${second}`, { ...off, enabled: true }, revisions()[2]!, 'panel'))
    .rejects.toThrow(new UserError('accountDisabled', { source: kind }))
  await expect(settings.save(`source:${kind}:acme~extra`, instance('acme/extra'), 0, 'panel')).rejects.toThrow(new UserError('accountDisabled', { source: kind }))
  expect(enabled()).toEqual({ [kind]: false, [first]: false, [second]: false })
  // An instance added switched off is fine under an account that is off.
  await settings.save(`source:${kind}:acme~extra`, { enabled: false, config: { repository: 'acme/extra' } }, 0, 'panel')
  expect(saved.settings().sources[`${kind}:acme~extra`]).toMatchObject({ enabled: false })
  // With the account on again the instances stay off until each is switched on one by one.
  await settings.save(`source:${kind}`, { ...saved.settings().sources[kind]!, enabled: true }, revisions()[0]!, 'panel')
  expect(enabled()).toEqual({ [kind]: true, [first]: false, [second]: false, [`${kind}:acme~extra`]: false })
  await settings.save(`source:${second}`, { ...saved.settings().sources[second]!, enabled: true }, saved.blockRevision(`source:${second}`), 'panel')
  expect(enabled()[second]).toBe(true)
  expect(enabled()[first]).toBe(false)
})

it('treats an instance as off under an account that is off even when it is stored on, so stored settings cannot run a repository', async () => {
  h = await startRuntime()
  store(h, { github: { ...h.runtime.store.settings().sources.github!, enabled: false } })
  const { sources, store: saved } = h.runtime
  expect(saved.settings().sources[WIDGETS]!.enabled).toBe(true)
  expect(sources.instance(WIDGETS)).toMatchObject({ enabled: false })
  expect(sources.scope({ source: WIDGETS, meta: {} })).toMatchObject({ listened: false, reason: 'source_disabled' })
  expect(sources.instances().find(item => item.id === WIDGETS)).toMatchObject({ enabled: false })
})

it('answers a repository switched on under an account that is off with 400 and its code over HTTP', async () => {
  h = await startRuntime()
  const { github } = h.runtime.store.settings().sources
  store(h, { github: { ...github!, enabled: false }, [WIDGETS]: { ...h.runtime.store.settings().sources[WIDGETS]!, enabled: false } })
  vi.spyOn(Setup.prototype, 'checkAccounts').mockResolvedValue(undefined)
  const block = `source:${WIDGETS}`
  const stored = h.runtime.store.settings().sources[WIDGETS]!
  expect(await h.api('PUT', `settings/${block}`, { value: { ...stored, enabled: true }, revision: h.runtime.store.blockRevision(block) }))
    .toMatchObject({ status: 400, body: { code: 'accountDisabled', values: { source: 'github' } } })
  expect(h.runtime.store.settings().sources[WIDGETS]!.enabled).toBe(false)
})

it.each([['github', WIDGETS], ['gitlab', 'gitlab:acme~tools']])('gives each %s repository card its own Policy part and its account card none, so the panel lists who may originate work per instance', async (kind, id) => {
  h = await startRuntime()
  h.runtime.sources.register(gitlabKind)
  const current = h.runtime.store.settings()
  store(h, { [id]: { enabled: true, config: { repository: kind === 'github' ? 'acme/widgets' : 'acme/tools' } } })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), policy: { ...current.policy,
    sources: { ...current.policy.sources, [id]: { allowed: [{ id: 'alice' }], admission: {} } } } })
  const view = await h.api('GET', 'settings')
  const cards = (view.body as { sources: { id: string; policy?: { fields: { key: string }[]; rows?: unknown[] } }[] }).sources
  const card = cards.find(item => item.id === id)!
  expect(card.policy?.fields.map(field => field.key)).toEqual(['allowed', 'bots'])
  expect(card.policy?.rows?.length).toBeGreaterThan(0)
  expect(cards.find(item => item.id === kind)!.policy).toBeUndefined()
})
