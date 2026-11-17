import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SettingsSchema, splitLegacyGitlab } from '../src/policy.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { gitlabInstanceId, gitlabRepositoryOf } from '../src/sources/gitlab-trigger.ts'
import type { SourceKind } from '../src/sources/kind.ts'

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
    expect(split.sources.gitlab!.config).toEqual({ host: 'gitlab.acme.test', cli: 'glab', failuresBeforeError: 4, defaultProject: 'apc/apc/server/ape' })
    expect(split.policy.sources['gitlab:apc~apc~server~ape']).toEqual({ allowed: [{ id: 'pankai' }] })
    expect(split.policy.sources.gitlab).toBeUndefined()
    // Idempotent: re-splitting the migrated shape changes nothing.
    expect(splitLegacyGitlab(split)).toEqual(split)
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
})
