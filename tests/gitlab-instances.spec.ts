import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Trigger } from '../src/core/index.ts'
import { SettingsSchema, splitLegacyGitlab } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { gitlabKind, pollRound } from '../src/sources/gitlab.ts'
import { gitlabInstanceId, gitlabRepositoryOf } from '../src/sources/gitlab-trigger.ts'
import { Store as AppStore } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment } from './fixtures/deployment.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { settingsView } from '../src/app/views/settings.ts'
import type { Store } from '../src/app/store.ts'

/** A legacy single-project GitLab settings payload, as stored before multi-instance support. */
const legacy = () => ({
  paused: false,
  sources: { gitlab: { enabled: true, config: { host: 'gitlab.acme.test', cli: 'glab', repository: 'apc/apc/server/ape',
    pollSeconds: 120, failuresBeforeError: 4, observeIssues: true } } },
  policy: { sources: { gitlab: { allowed: [{ id: 'pankai' }] } } },
  eval: {},
  executor: {},
})

describe('GitLab multi-instance settings', () => {
  it('encodes project paths as instance IDs and decodes them back', () => {
    expect(gitlabInstanceId('apc/apc/server/ape')).toBe('gitlab:apc~apc~server~ape')
    expect(gitlabRepositoryOf('gitlab:apc~apc~server~ape')).toBe('apc/apc/server/ape')
    expect(gitlabRepositoryOf('gitlab')).toBeUndefined()
    expect(gitlabRepositoryOf('github:12')).toBeUndefined()
  })

  it('splits a legacy single-project GitLab entry into an account and one instance', () => {
    const split = splitLegacyGitlab(legacy()) as unknown as { sources: Record<string, { enabled: boolean; config: Record<string, unknown> }>; policy: { sources: Record<string, unknown> } }
    expect(split.sources['gitlab:apc~apc~server~ape']).toEqual({ enabled: true,
      config: { repository: 'apc/apc/server/ape', pollSeconds: 120, observeIssues: true } })
    // The account keeps its own fields; the removed `defaultProject` is dropped rather than carried over.
    expect(split.sources.gitlab!.config).toEqual({ host: 'gitlab.acme.test', cli: 'glab', failuresBeforeError: 4 })
    expect(split.policy.sources['gitlab:apc~apc~server~ape']).toEqual({ allowed: [{ id: 'pankai' }] })
    expect(split.policy.sources.gitlab).toBeUndefined()
    // Idempotent: re-splitting the migrated shape changes nothing.
    expect(splitLegacyGitlab(split)).toEqual(split)
  })

  it('parses a stored account that still carries the removed defaultProject, dropping the key', () => {
    const settings = SettingsSchema.parse({ sources: { gitlab: { enabled: true, config: { host: 'gitlab.acme.test', cli: 'glab', defaultProject: 'apc/apc/server/ape' } } } })
    expect(settings.sources.gitlab!.config).toEqual({ host: 'gitlab.acme.test', cli: 'glab' })
    expect(Object.keys(settings.sources)).toEqual(['gitlab'])
  })

  it('parses instance-qualified source keys and refuses malformed ones', () => {
    const settings = SettingsSchema.parse({ sources: { 'gitlab:apc~apc~server~ape': { enabled: true, config: {} } } })
    expect(Object.keys(settings.sources)).toEqual(['gitlab:apc~apc~server~ape'])
    expect(() => SettingsSchema.parse({ sources: { 'gitlab:apc/apc': { enabled: true, config: {} } } })).toThrow()
    expect(() => SettingsSchema.parse({ sources: { 'gitlab:': { enabled: true, config: {} } } })).toThrow()
  })

  it('routes registry lookups between the account entry and each instance', () => {
    const settings = SettingsSchema.parse({ sources: {
      probe: { enabled: true, config: {} },
      'probe:apc~ape': { enabled: true, config: {} },
      'probe:acme~widgets': { enabled: true, config: {} },
    } })
    const registry = new SourceRegistry(() => settings, new HealthBoard())
    const kind: SourceKind<Record<string, unknown>, Record<string, unknown>> = {
      kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: ['probe'], fields: [],
      schema: z.object({}).passthrough(),
      multi: { schema: z.object({ project: z.string().default('') }).passthrough() },
    }
    const unregister = registry.register(kind)
    expect(registry.instances().map(instance => instance.id)).toEqual(['probe', 'probe:apc~ape', 'probe:acme~widgets'])
    expect(registry.kind('probe')?.kind).toBe('probe')
    expect(registry.instance('probe:apc~ape')?.config).toEqual({ project: '' })
    expect(registry.instance('probe:acme~widgets')?.enabled).toBe(true)
    unregister()
  })

  it('shows account fields on the account card and instance fields on each instance card', () => {
    const settings = SettingsSchema.parse({ sources: {
      probe: { enabled: true, config: {} },
      'probe:apc~ape': { enabled: true, config: {} },
    } })
    const registry = new SourceRegistry(() => settings, new HealthBoard())
    const kind: SourceKind<Record<string, unknown>, Record<string, unknown>> = {
      kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: ['probe'],
      fields: [{ key: 'host', type: 'text', label: { zh: '服务器', en: 'Server' } }],
      schema: z.object({}).passthrough(),
      multi: { schema: z.object({ project: z.string().default('') }).passthrough(),
        fields: [{ key: 'project', type: 'text', label: { zh: '项目', en: 'Project' } }] },
    }
    const unregister = registry.register(kind)
    const store = { settings: () => settings, blockRevision: () => 0, get: () => undefined } as unknown as Store
    const view = settingsView(store, registry, {}, {}, '/srv')
    expect(view.sources.map(source => source.id)).toEqual(['probe', 'probe:apc~ape'])
    expect(view.sources[0]!.fields.map(field => field.key)).toEqual(['host'])
    expect(view.sources[1]!.fields.map(field => field.key)).toEqual(['project'])
    expect(view.sources[1]!.value.config).toEqual({ project: '' })
    unregister()
  })
})

const APE = 'apc/apc/server/ape'
const AGENT = 'agent-bot'
/** One GitLab instance watched for Issues and comments, with the agent's glab login stubbed to answer from `routes` (paths below `projects/<project>/`). */
async function poll(routes: Record<string, unknown>): Promise<Trigger[]> {
  const instance = { source: gitlabInstanceId(APE), project: APE }
  const store = new AppStore(join(mkdtempSync(join(tmpdir(), 'gitlab-own-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { gitlab: { enabled: true, config: { host: 'gitlab.acme.test', cli: 'glab' } },
    [instance.source]: { enabled: true, config: { repository: APE, observeIssues: true, observeComments: true } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const deployment = testDeployment({ gitlab: { cli: '/bin/false', host: 'gitlab.acme.test', login: AGENT, noreply: '' } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const run = vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    const path = args[1]!.replace(/^projects\/[^/]+\/?/, '')
    const [base, query = ''] = path.split('?') as [string, string?]
    // The two Issue lists differ by their query: the new-Issue stream reads every state.
    const route = routes[base === 'issues' && query.includes('state=all') ? 'issues:new' : base]
    return JSON.stringify(route ?? [])
  })
  const received: Trigger[] = []
  const receive = vi.fn(async (trigger: Trigger) => { received.push(trigger); return 'stored' as const })
  const parts: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() }, outbox: { send: vi.fn() }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive }
  sources.instanceHealth(instance.source)
  await pollRound(sourceContextOf(parts, { kind: 'gitlab', health: [instance.source] }), instance)
  run.mockRestore()
  store.close()
  return received
}
describe('GitLab taking in the agent account\'s own writing', () => {
  const later = new Date(Date.now() + 60_000).toISOString()
  const issue = (iid: number, username: string, body: string) => ({ iid, title: `Issue ${iid}`, body, state: 'opened', created_at: later, updated_at: later,
    web_url: `https://gitlab.acme.test/${APE}/-/issues/${iid}`, author: { username, id: 1 } })
  const note = (id: number, username: string, body: string, system = false) => ({ id, body, system, author: { username, id: 1 }, created_at: later, updated_at: later })
  it('takes in an Issue the agent account opened as an ordinary human Trigger, and still skips what carries its reply marker', async () => {
    const routes = { 'issues:new': [issue(1, AGENT, 'please fix the login'), issue(2, AGENT, 'done <!-- dsh-superagent:dsh-superagent:r1 -->'), issue(3, 'alice', 'hi')] }
    const received = await poll(routes)
    expect(received.map(trigger => trigger.meta.iid)).toEqual([1, 3])
    expect(received[0]).toMatchObject({ actor: { id: AGENT }, human: true })
  })
  it('reads the Issue text GitLab calls description as the Trigger body, and a mention in it addresses the agent', async () => {
    const raw = { iid: 7, title: 'test harness', description: `@${AGENT} list the projects you control`, state: 'opened', created_at: later, updated_at: later,
      web_url: `https://gitlab.acme.test/${APE}/-/issues/7`, author: { username: 'alice', id: 2 } }
    const [trigger] = await poll({ 'issues:new': [raw] })
    expect(trigger).toMatchObject({ text: `test harness\n\n@${AGENT} list the projects you control`, addressed: 'mention' })
  })
  it('takes in the agent account\'s own note only when it mentions the agent, never a system note or a marked reply', async () => {
    const routes = { issues: [issue(5, 'alice', 'hi')], 'issues/5/notes': [note(1, AGENT, `@${AGENT} please take this`), note(2, AGENT, 'on it'),
      note(3, AGENT, `@${AGENT} done <!-- dsh-superagent:dsh-superagent:r1 -->`), note(4, AGENT, `@${AGENT} assigned`, true), note(5, 'alice', 'thanks')] }
    const received = await poll(routes)
    expect(received.map(trigger => trigger.meta.noteId)).toEqual([1, 5])
    expect(received[0]).toMatchObject({ actor: { id: AGENT }, human: true, addressed: 'mention' })
  })
})
