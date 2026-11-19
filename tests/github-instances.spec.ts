import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { key, type Thread, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, splitLegacyGithub, splitLegacyGitlab, type Settings } from '../src/policy.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { githubKind, pollRound, pollThreads } from '../src/sources/github.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { githubChannel, githubInstanceId, githubRepositoryOf, githubThread, parseThread, type Instance } from '../src/sources/github-trigger.ts'
import { settingsView } from '../src/app/views/settings.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WIDGETS = 'acme/widgets'
const GADGETS = 'acme/gadgets'
const widgets: Instance = { source: githubInstanceId(WIDGETS), repository: WIDGETS }
const gadgets: Instance = { source: githubInstanceId(GADGETS), repository: GADGETS }

/** A legacy single-repository GitHub settings payload, as stored before multi-instance support. */
const legacy = () => ({
  paused: false,
  sources: { github: { enabled: true, config: { cli: 'gh', repository: WIDGETS, pollSeconds: 120, failuresBeforeError: 4,
    observeIssues: true, observePulls: true, observeComments: false, observeCi: true } } },
  policy: { sources: { github: { allowed: [{ id: 'alice' }] } } },
  eval: {},
  executor: {},
})
type Split = { sources: Record<string, { enabled: boolean; config: Record<string, unknown> }>; policy: { sources: Record<string, unknown> } }

describe('GitHub multi-instance settings', () => {
  it('encodes repositories as instance IDs and decodes them back', () => {
    expect(githubInstanceId(WIDGETS)).toBe('github:acme~widgets')
    expect(githubRepositoryOf('github:acme~widgets')).toBe(WIDGETS)
    expect(githubRepositoryOf('github')).toBeUndefined()
    expect(githubRepositoryOf('gitlab:apc~ape')).toBeUndefined()
    // A Thread key is its instance and the number; branch CI threads carry no number.
    expect(githubThread(widgets.source, 12)).toBe('github:acme~widgets:12')
    expect(parseThread('github:acme~widgets:12')).toEqual({ source: 'github:acme~widgets', number: 12 })
    expect(parseThread('github:acme~widgets:ci:main')).toBeUndefined()
    expect(parseThread('github:12')).toBeUndefined()
    expect(githubChannel(widgets, 12, 'https://github.com/acme/widgets/issues/12')).toEqual({ source: widgets.source, thread: 'github:acme~widgets:12',
      address: { number: '12', repository: WIDGETS, url: 'https://github.com/acme/widgets/issues/12' } })
  })

  it('splits a legacy single-repository GitHub entry into an account and one instance', () => {
    const split = splitLegacyGithub(legacy()) as unknown as Split
    expect(split.sources['github:acme~widgets']).toEqual({ enabled: true,
      config: { repository: WIDGETS, pollSeconds: 120, observeIssues: true, observePulls: true, observeComments: false, observeCi: true } })
    // The account keeps what belongs to the GitHub account itself, and nothing about the repository.
    expect(split.sources.github!.config).toEqual({ cli: 'gh', failuresBeforeError: 4 })
    expect(split.policy.sources['github:acme~widgets']).toEqual({ allowed: [{ id: 'alice' }] })
    expect(split.policy.sources.github).toBeUndefined()
    // Idempotent: re-splitting the migrated shape changes nothing, and neither does parsing it again.
    expect(splitLegacyGithub(split)).toEqual(split)
    expect(SettingsSchema.parse(split)).toEqual(SettingsSchema.parse(legacy()))
  })

  it('migrates legacy settings while parsing them, and keeps a disabled Source disabled', () => {
    const settings = SettingsSchema.parse(legacy())
    expect(Object.keys(settings.sources).sort()).toEqual(['github', 'github:acme~widgets'])
    expect(settings.sources['github:acme~widgets']).toMatchObject({ enabled: true, config: { repository: WIDGETS, pollSeconds: 120 } })
    expect(settings.policy.sources['github:acme~widgets']).toMatchObject({ allowed: [{ id: 'alice' }] })
    expect(settings.policy.sources.github).toBeUndefined()
    const off = legacy()
    off.sources.github.enabled = false
    const disabled = SettingsSchema.parse(off)
    expect(disabled.sources['github:acme~widgets']!.enabled).toBe(false)
    expect(disabled.sources.github!.enabled).toBe(false)
  })

  it('leaves settings alone that carry no legacy repository, and does not split once an instance is stored', () => {
    const settings = { sources: { github: { enabled: true, config: { cli: 'gh' } }, 'github:acme~widgets': { enabled: true, config: { repository: WIDGETS } } } }
    expect(splitLegacyGithub(settings)).toBe(settings)
    expect(splitLegacyGithub({})).toEqual({})
    // A repository left in the account beside a stored instance leaves the stored instance as it is.
    const both = { sources: { github: { enabled: true, config: { repository: GADGETS, observeCi: true } }, 'github:acme~widgets': { enabled: true, config: { repository: WIDGETS } } } }
    const split = splitLegacyGithub(both) as unknown as Split
    expect(Object.keys(split.sources).sort()).toEqual(['github', 'github:acme~widgets'])
    expect(split.sources['github:acme~widgets']!.config).toEqual({ repository: WIDGETS })
  })

  it('parses instance-qualified source keys and refuses malformed ones', () => {
    const settings = SettingsSchema.parse({ sources: { 'github:acme~widgets': { enabled: true, config: {} } } })
    expect(Object.keys(settings.sources)).toEqual(['github:acme~widgets'])
    expect(() => SettingsSchema.parse({ sources: { 'github:acme/widgets': { enabled: true, config: {} } } })).toThrow()
    expect(() => SettingsSchema.parse({ sources: { 'github:': { enabled: true, config: {} } } })).toThrow()
  })

  it('still parses a legacy GitLab account that carries the removed defaultProject, and drops the key', () => {
    const account = { host: 'gitlab.acme.test', cli: 'glab', failuresBeforeError: 4, defaultProject: 'apc/apc/server/ape' }
    const settings = SettingsSchema.parse({ sources: { gitlab: { enabled: true, config: account } } })
    expect(settings.sources.gitlab!.config).toEqual({ host: 'gitlab.acme.test', cli: 'glab', failuresBeforeError: 4 })
    // With no repository stored there is no instance to create, and the account passes the kind's strict schema.
    expect(Object.keys(settings.sources)).toEqual(['gitlab'])
    const registry = new SourceRegistry(() => settings, new HealthBoard())
    registry.register(gitlabKind)
    expect(registry.validate('gitlab', settings.sources.gitlab!).config).toEqual({ host: 'gitlab.acme.test', cli: 'glab', failuresBeforeError: 4 })
    // Beside a legacy repository the project becomes the instance, and defaultProject is not carried to the account.
    const split = splitLegacyGitlab({ sources: { gitlab: { enabled: true, config: { ...account, repository: 'apc/apc/server/ape', pollSeconds: 90 } } } }) as unknown as Split
    expect(split.sources.gitlab!.config).toEqual({ host: 'gitlab.acme.test', cli: 'glab', failuresBeforeError: 4 })
    expect(split.sources['gitlab:apc~apc~server~ape']).toEqual({ enabled: true, config: { repository: 'apc/apc/server/ape', pollSeconds: 90 } })
    // Once the account lost the key a second split leaves everything as it is.
    expect(splitLegacyGitlab(split)).toBe(split)
  })
})

describe('GitHub account and instance fields', () => {
  it('keeps the account to its CLI and failure threshold, and each instance to its repository and switches', () => {
    expect(githubKind.fields.map(field => field.key)).toEqual(['cli', 'failuresBeforeError'])
    expect(githubKind.multi!.fields!.map(field => field.key)).toEqual(['repository', 'pollSeconds', 'observeIssues', 'observePulls', 'observeComments', 'observeCi'])
    expect(githubKind.health).toEqual(['github'])
    expect(githubKind.schema.parse({})).toEqual({ cli: '', failuresBeforeError: 3 })
    expect(githubKind.multi!.schema.parse({ repository: WIDGETS })).toEqual({ repository: WIDGETS, pollSeconds: 60, observeIssues: false,
      observePulls: false, observeComments: false, observeCi: false })
    // Neither shape accepts the other's fields.
    expect(() => githubKind.schema.parse({ repository: WIDGETS })).toThrow()
    expect(() => githubKind.schema.parse({ pollSeconds: 60 })).toThrow()
    expect(() => githubKind.multi!.schema.parse({ repository: WIDGETS, cli: 'gh' })).toThrow()
    expect(() => githubKind.multi!.schema.parse({})).toThrow()
    expect(() => githubKind.multi!.schema.parse({ repository: 'widgets' })).toThrow()
    expect(() => githubKind.multi!.schema.parse({ repository: WIDGETS, pollSeconds: 30 })).toThrow()
  })

  it('shows the account fields on the account card and the instance fields on each repository card', () => {
    const settings = SettingsSchema.parse({ sources: { github: { enabled: true, config: {} },
      'github:acme~widgets': { enabled: true, config: { repository: WIDGETS } }, 'github:acme~gadgets': { enabled: false, config: { repository: GADGETS } } } })
    const registry = new SourceRegistry(() => settings, new HealthBoard())
    const unregister = registry.register(githubKind)
    const store = { settings: () => settings, blockRevision: () => 0, get: () => undefined } as unknown as Store
    const view = settingsView(store, registry, {}, {}, '/srv')
    expect(view.sources.map(source => source.id)).toEqual(['github', 'github:acme~widgets', 'github:acme~gadgets'])
    expect(view.sources[0]!.fields.map(field => field.key)).toEqual(['cli', 'failuresBeforeError'])
    expect(view.sources[1]!.fields.map(field => field.key)).toEqual(['repository', 'pollSeconds', 'observeIssues', 'observePulls', 'observeComments', 'observeCi'])
    expect(view.sources[1]!.value.config).toMatchObject({ repository: WIDGETS, pollSeconds: 60 })
    expect(view.sources[2]!.value).toMatchObject({ enabled: false, config: { repository: GADGETS } })
    unregister()
  })
})

describe('GitHub instance routing', () => {
  const probe = (): SourceKind<Record<string, unknown>, Record<string, unknown>> => ({
    kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: ['probe'], fields: [],
    schema: z.object({}).passthrough(), multi: { schema: z.object({ repository: z.string().default('') }).passthrough() } })
  const registryOf = (sources: Record<string, { enabled: boolean; config: Record<string, unknown> }>) => {
    const settings = SettingsSchema.parse({ sources })
    const registry = new SourceRegistry(() => settings, new HealthBoard())
    registry.register(githubKind)
    registry.register(probe())
    return { settings, registry }
  }

  it('picks the first enabled instance for a source that names none of this kind, and the instance a source names', () => {
    const { settings, registry } = registryOf({ github: { enabled: true, config: {} },
      'github:acme~gadgets': { enabled: false, config: { repository: GADGETS } }, 'github:acme~widgets': { enabled: true, config: { repository: WIDGETS } },
      'github:acme~extras': { enabled: true, config: { repository: 'acme/extras' } } })
    expect(registry.instanceIds('github')).toEqual(['github:acme~gadgets', 'github:acme~widgets', 'github:acme~extras'])
    // A chat ticket (no source, or another kind's source) lands in the first enabled repository, skipping the disabled one.
    expect(registry.instanceIdFor(undefined, 'github')).toBe('github:acme~widgets')
    expect(registry.instanceIdFor('feishu', 'github')).toBe('github:acme~widgets')
    expect(registry.instanceIdFor('gitlab:apc~ape', 'github')).toBe('github:acme~widgets')
    // A ticket from a repository stays in it, enabled or not; an unstored one routes nowhere.
    expect(registry.instanceIdFor('github:acme~extras', 'github')).toBe('github:acme~extras')
    expect(registry.instanceIdFor('github:acme~gadgets', 'github')).toBe('github:acme~gadgets')
    expect(registry.instanceIdFor('github:nobody~nothing', 'github')).toBeUndefined()
    // The environment of a repository-bound ticket is that repository's, and a foreign one's is the first enabled repository's.
    const repositoryOf = (source?: string) => registry.environments(settings, source).filter(entry => entry.kind.kind === 'github').map(entry => entry.config.repository)
    expect(repositoryOf('github:acme~extras')).toEqual(['acme/extras'])
    expect(repositoryOf('feishu')).toEqual([WIDGETS])
    expect(repositoryOf()).toEqual([WIDGETS])
  })

  it('falls back to the first stored instance when every one is off, and to none when none is stored', () => {
    const off = registryOf({ github: { enabled: true, config: {} }, 'github:acme~gadgets': { enabled: false, config: { repository: GADGETS } },
      'github:acme~widgets': { enabled: false, config: { repository: WIDGETS } } })
    expect(off.registry.instanceIdFor(undefined, 'github')).toBe('github:acme~gadgets')
    expect(off.registry.environments(off.settings).filter(entry => entry.kind.kind === 'github')).toEqual([])
    const none = registryOf({ github: { enabled: true, config: {} } })
    expect(none.registry.instanceIds('github')).toEqual([])
    expect(none.registry.instanceIdFor(undefined, 'github')).toBeUndefined()
    expect(none.registry.instanceIdFor('github:acme~widgets', 'github')).toBeUndefined()
    // A kind that is not multi-instance routes to itself.
    expect(none.registry.instanceIdFor('github:acme~widgets', 'unknown')).toBe('unknown')
  })

  it('lists the account before its instances, and claims one health entry per instance', () => {
    const { registry } = registryOf({ 'github:acme~widgets': { enabled: true, config: { repository: WIDGETS } }, github: { enabled: true, config: {} },
      'github:acme~gadgets': { enabled: true, config: { repository: GADGETS } } })
    expect(registry.instances().map(instance => instance.id).filter(id => id.startsWith('github'))).toEqual(['github', 'github:acme~widgets', 'github:acme~gadgets'])
    const first = registry.instanceHealth('github:acme~widgets')
    expect(first).toBeDefined()
    expect(registry.instanceHealth('github:acme~widgets')).toBe(first)
    expect(registry.instanceHealth('github:acme~gadgets')).not.toBe(first)
    // The account key and an unknown kind have no per-instance entry.
    expect(registry.instanceHealth('github')).toBeUndefined()
    expect(registry.instanceHealth('nothing:acme~widgets')).toBeUndefined()
  })
})

/** Two watched repositories with the same Issue number, one Store, one Commands, and one context per instance. */
function harness(): { store: Store; commands: Commands; board: HealthBoard; sources: SourceRegistry; settings: Settings; receive: ReturnType<typeof vi.fn<(trigger: Trigger) => Promise<'stored'>>>
  contextOf: (instance: Instance) => ReturnType<typeof sourceContextOf> } {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'github-instances-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ sources: { github: { enabled: true, config: {} },
    [widgets.source]: { enabled: true, config: { repository: WIDGETS } }, [gadgets.source]: { enabled: true, config: { repository: GADGETS } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(githubKind)
  const deployment = testDeployment()
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (_trigger: Trigger) => 'stored' as const)
  const parts: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() }, outbox: { send: vi.fn() }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive }
  // Each instance reports through its own health entry, claimed before the context that reports to it exists.
  const contextOf = (instance: Instance) => { sources.instanceHealth(instance.source); return sourceContextOf(parts, { kind: 'github', health: [instance.source] }) }
  return { store, commands, board, sources, settings, receive, contextOf }
}
const refused = (status: number, text: string) => commandError({ stderr: `gh: ${text} (HTTP ${status})`, code: 1 })
/** Stubs `gh api` for several repositories at once: routes are keyed by their full path (`repos/<owner>/<name>/<path>`), and every read is recorded. */
function github(commands: Commands, routes: Record<string, unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    reads.push(args[1]!)
    const path = args[1]!.split('?')[0]!
    const route = routes[path] ?? (/\/(comments|reviews|statuses)$/.test(path) ? [] : refused(404, 'Not Found'))
    const value: unknown = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    if (args.includes('--include')) return `HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify(value)}`
    return JSON.stringify(args.includes('--slurp') ? [value] : value)
  })
  return reads
}
/** An Issue 12 as GitHub returns it for `repository`, opened after the cursor, and the notification that names it. */
const issueOf = (repository: string, title: string) => ({ id: 1012, number: 12, title, body: '@agent-bot please look', state: 'open', created_at: '2026-09-09T00:00:00Z',
  html_url: `https://github.com/${repository}/issues/12`, user: { login: 'alice', type: 'User' } })
const notificationOf = (repository: string, title: string) => ({ id: `n-${repository}`, updated_at: '2026-09-09T00:00:00Z', reason: 'mention',
  repository: { full_name: repository }, subject: { url: `https://api.github.com/repos/${repository}/issues/12`, type: 'Issue', title } })
const SINCE = '2026-09-08T00:00:00.000Z'

describe('GitHub instances polling', () => {
  it('polls each instance on its own repository with its own thread keys, trigger IDs and read positions', async () => {
    const h = harness()
    for (const instance of [widgets, gadgets]) h.store.set(KV.github.since(instance.source), SINCE)
    const reads = github(h.commands, {
      'repos/acme/widgets/notifications': [notificationOf(WIDGETS, 'Login fails')], 'repos/acme/widgets/issues/12': issueOf(WIDGETS, 'Login fails'),
      'repos/acme/gadgets/notifications': [notificationOf(GADGETS, 'Gears jam')], 'repos/acme/gadgets/issues/12': issueOf(GADGETS, 'Gears jam') })
    await pollRound(h.contextOf(widgets), widgets)
    // Only the first instance's repository was read, and only it took in an Issue.
    expect(reads.every(path => path.startsWith('repos/acme/widgets/'))).toBe(true)
    expect(h.receive).toHaveBeenCalledTimes(1)
    await pollRound(h.contextOf(gadgets), gadgets)
    expect(reads.filter(path => path.startsWith('repos/acme/gadgets/')).length).toBeGreaterThan(0)
    expect(h.receive).toHaveBeenCalledTimes(2)
    const [first, second] = h.receive.mock.calls.map(([trigger]) => trigger)
    // The same number in two repositories is two Issues: each with its instance as the source, its own Thread, Trigger ID and address.
    expect(first).toMatchObject({ source: widgets.source, threads: [{ source: widgets.source, id: '12' }], url: 'https://github.com/acme/widgets/issues/12',
      channel: githubChannel(widgets, 12, 'https://github.com/acme/widgets/issues/12'), meta: { number: 12, kind: 'issue', repository: WIDGETS } })
    expect(second).toMatchObject({ source: gadgets.source, threads: [{ source: gadgets.source, id: '12' }], url: 'https://github.com/acme/gadgets/issues/12',
      channel: githubChannel(gadgets, 12, 'https://github.com/acme/gadgets/issues/12'), meta: { number: 12, kind: 'issue', repository: GADGETS } })
    expect(first!.id).toBe(key('github-issue', widgets.source, '12'))
    expect(second!.id).toBe(key('github-issue', gadgets.source, '12'))
    expect(first!.id).not.toBe(second!.id)
    // Each instance keeps its own notification cursor and its own per-Thread read position.
    expect(h.store.keys(KV.github.since)).toEqual(expect.arrayContaining([KV.github.since(widgets.source), KV.github.since(gadgets.source)]))
    expect(h.store.get(KV.github.since(widgets.source))).not.toBe(SINCE)
    expect(h.store.get(KV.github.since(gadgets.source))).not.toBe(SINCE)
    expect(h.store.keys(KV.github.cursor).sort()).toEqual([KV.github.cursor('github:acme~gadgets:12'), KV.github.cursor('github:acme~widgets:12')].sort())
    // Each instance reports its round on its own health entry, and the account entry stays out of it.
    expect(h.board.all[widgets.source]).toMatchObject({ state: 'ready', detail: '1 notifications; next poll ≥ 60s' })
    expect(h.board.all[gadgets.source]).toMatchObject({ state: 'ready', detail: '1 notifications; next poll ≥ 60s' })
    h.store.close()
  })

  it('fails one instance\'s round without moving the other\'s read position or health', async () => {
    const h = harness()
    for (const instance of [widgets, gadgets]) h.store.set(KV.github.since(instance.source), SINCE)
    github(h.commands, { 'repos/acme/widgets/notifications': [notificationOf(WIDGETS, 'Login fails')], 'repos/acme/widgets/issues/12': issueOf(WIDGETS, 'Login fails'),
      'repos/acme/gadgets/notifications': refused(502, 'Bad Gateway') })
    await expect(pollRound(h.contextOf(gadgets), gadgets)).rejects.toThrow('502')
    expect(h.store.get(KV.github.since(gadgets.source))).toBe(SINCE)
    await pollRound(h.contextOf(widgets), widgets)
    expect(h.store.get(KV.github.since(widgets.source))).not.toBe(SINCE)
    expect(h.store.get(KV.github.since(gadgets.source))).toBe(SINCE)
    expect(h.board.all[widgets.source]).toMatchObject({ state: 'ready' })
    expect(h.board.all[gadgets.source]).toMatchObject({ state: 'starting' })
    // A failed read is retried per instance: the failure of #12 in one repository leaves no retry in the other.
    expect(h.store.get(KV.github.retries(gadgets.source))).toBeUndefined()
    expect(h.store.get(KV.github.retries(widgets.source))).toEqual({})
    h.store.close()
  })

  it('keeps a retry of the same number in each instance apart', async () => {
    const h = harness()
    for (const instance of [widgets, gadgets]) {
      h.store.set(KV.github.since(instance.source), SINCE)
      h.store.threads.save({ key: githubThread(instance.source, 12), ref: { source: instance.source, id: '12' }, createdAt: '2026-09-01T00:00:00Z',
        lastAt: new Date().toISOString(), subscriptions: [], correlated: [], pending: [], meta: { number: 12, isPr: false } })
    }
    github(h.commands, { 'repos/acme/widgets/notifications': [notificationOf(WIDGETS, 'Login fails')], 'repos/acme/widgets/issues/12': refused(502, 'Bad Gateway'),
      'repos/acme/gadgets/notifications': [notificationOf(GADGETS, 'Gears jam')], 'repos/acme/gadgets/issues/12': issueOf(GADGETS, 'Gears jam') })
    await expect(pollRound(h.contextOf(widgets), widgets)).rejects.toThrow('#12')
    await pollRound(h.contextOf(gadgets), gadgets)
    expect(Object.keys(h.store.get(KV.github.retries(widgets.source))!)).toEqual(['12'])
    expect(h.store.get(KV.github.retries(gadgets.source))).toEqual({})
    expect(h.store.threads.get('github:acme~widgets:12')?.meta.pollError).toContain('502')
    expect(h.store.threads.get('github:acme~gadgets:12')?.meta).not.toHaveProperty('pollError')
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0].source).toBe(gadgets.source)
    h.store.close()
  })

  it('polls the subscribed Threads of an instance only, with the same number in two repositories read apart', async () => {
    const h = harness()
    const thread = (instance: Instance): Thread => ({ key: githubThread(instance.source, 7), ref: { source: instance.source, id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: false, title: 'Login fails' } })
    h.store.threads.save(thread(widgets))
    h.store.threads.save(thread(gadgets))
    const comment = (id: number, login: string) => ({ id, body: `comment ${id}`, user: { login }, created_at: '2026-09-01T02:00:00Z', updated_at: '2026-09-01T02:00:00Z' })
    const reads = github(h.commands, { 'repos/acme/widgets/issues/7/comments': [comment(1, 'bob')], 'repos/acme/gadgets/issues/7/comments': [comment(2, 'carol')] })
    await pollThreads(h.contextOf(gadgets), gadgets)
    expect(reads.map(path => path.split('?')[0])).toEqual(['repos/acme/gadgets/issues/7/comments'])
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ actor: { source: gadgets.source, id: 'carol' }, text: 'comment 2', threads: [{ source: gadgets.source, id: '7' }], meta: { repository: GADGETS } })
    // Only the polled instance's Thread has a read position; the other's is untouched until its own round.
    expect(h.store.keys(KV.github.cursor)).toEqual([KV.github.cursor('github:acme~gadgets:7')])
    await pollThreads(h.contextOf(widgets), widgets)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.receive.mock.calls[1]![0]).toMatchObject({ actor: { source: widgets.source, id: 'bob' }, text: 'comment 1', threads: [{ source: widgets.source, id: '7' }], meta: { repository: WIDGETS } })
    expect(h.store.keys(KV.github.cursor).sort()).toEqual([KV.github.cursor('github:acme~gadgets:7'), KV.github.cursor('github:acme~widgets:7')].sort())
    h.store.close()
  })

  it('moves no read position of an instance that was switched off, while the other keeps polling', async () => {
    const h = harness()
    for (const instance of [widgets, gadgets]) h.store.set(KV.github.since(instance.source), SINCE)
    github(h.commands, { 'repos/acme/widgets/notifications': [notificationOf(WIDGETS, 'Login fails')], 'repos/acme/widgets/issues/12': issueOf(WIDGETS, 'Login fails'),
      'repos/acme/gadgets/notifications': [notificationOf(GADGETS, 'Gears jam')], 'repos/acme/gadgets/issues/12': issueOf(GADGETS, 'Gears jam') })
    h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, [widgets.source]: { enabled: false, config: { repository: WIDGETS } } } })
    await pollRound(h.contextOf(widgets), widgets)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.github.since(widgets.source))).toBe(SINCE)
    await pollRound(h.contextOf(gadgets), gadgets)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0].source).toBe(gadgets.source)
    h.store.close()
  })
})
