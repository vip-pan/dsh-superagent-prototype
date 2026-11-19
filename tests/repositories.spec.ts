// Which repositories a request is submitted to, their chain, and where each one's clone lives.
import { describe, expect, it } from 'vitest'
import { chainOf, clonePath, cloneUrl, instanceOf, nodeOf, repositoriesSection, repositoryDirectory, repositoryNodes, splitList, targetRepositories } from '../src/repositories.ts'

const instance = (repository: string, config: Record<string, unknown> = {}, enabled = true) => ({ enabled, config: { repository, ...config } })
const settings = (extra: Record<string, { enabled: boolean; config: Record<string, unknown> }> = {}, github = true) => ({
  sources: { github: { enabled: github, config: {} }, gitlab: { enabled: true, config: {} },
    'gitlab:apc~web': instance('apc/web', { tags: 'frontend', calls: 'apc/server' }),
    'gitlab:apc~server': instance('apc/server', { tags: 'backend, gateway', calls: 'ape', localPath: '/srv/server' }),
    'gitlab:apc~ape': instance('apc/ape', { tags: 'evaluation' }),
    'github:acme~widgets': instance('acme/widgets'),
    ...extra },
}) as never
const ids = (result: ReturnType<typeof targetRepositories>) => 'ids' in result ? result.ids : result.error

describe('repository nodes', () => {
  it('lists the enabled instances of an enabled account with their tags, calls and clone', () => {
    const nodes = repositoryNodes(settings({ 'gitlab:apc~off': instance('apc/off', {}, false) }))
    expect(nodes.map(node => node.id)).toEqual(['github:acme~widgets', 'gitlab:apc~ape', 'gitlab:apc~server', 'gitlab:apc~web'])
    expect(nodes.find(node => node.id === 'gitlab:apc~server')).toMatchObject({ tags: ['backend', 'gateway'], calls: ['ape'], localPath: '/srv/server' })
    expect(repositoryNodes(settings({}, false)).map(node => node.id)).not.toContain('github:acme~widgets')
  })
  it('splits lists on commas, semicolons and lines, once each', () => {
    expect(splitList('a, b；c\nb')).toEqual(['a', 'b', 'c'])
    expect(splitList(undefined)).toEqual([])
  })
  it('names a repository by key, full name or unique last segment', () => {
    const nodes = repositoryNodes(settings())
    expect(nodeOf(nodes, 'apc/server')?.id).toBe('gitlab:apc~server')
    expect(nodeOf(nodes, 'GITLAB:apc~web')?.id).toBe('gitlab:apc~web')
    expect(nodeOf(nodes, 'widgets')?.id).toBe('github:acme~widgets')
    expect(nodeOf(nodes, 'unknown')).toBeUndefined()
  })
  it('puts a clone where it is configured, else under the state directory, and builds its URL from the host', () => {
    const [widgets, ape, server] = [repositoryNodes(settings())[0]!, repositoryNodes(settings())[1]!, repositoryNodes(settings())[2]!]
    expect(clonePath(server, '/state')).toBe('/srv/server')
    expect(clonePath(ape, '/state')).toBe('/state/clones/apc~ape')
    expect(repositoryDirectory('gitlab:apc~ape')).toBe('apc~ape')
    expect(cloneUrl(ape, 'gitlab.example.com')).toBe('https://gitlab.example.com/apc/ape.git')
    expect(cloneUrl(widgets, 'gitlab.example.com')).toBe('https://github.com/acme/widgets.git')
  })
})
describe('the chain', () => {
  it('follows calls downstream and the callers upstream, however many hops', () => {
    const nodes = repositoryNodes(settings())
    const web = nodes.find(node => node.id === 'gitlab:apc~web')!, ape = nodes.find(node => node.id === 'gitlab:apc~ape')!
    expect(chainOf(nodes, web).downstream.map(node => node.id)).toEqual(['gitlab:apc~server', 'gitlab:apc~ape'])
    expect(chainOf(nodes, ape).upstream.map(node => node.id)).toEqual(['gitlab:apc~server', 'gitlab:apc~web'])
    expect(chainOf(nodes, web).upstream).toEqual([])
  })
  it('survives a cycle', () => {
    const cyclic = settings({ 'gitlab:apc~ape': instance('apc/ape', { calls: 'apc/web' }) })
    const nodes = repositoryNodes(cyclic)
    expect(chainOf(nodes, nodes.find(node => node.id === 'gitlab:apc~web')!).downstream.map(node => node.id)).toEqual(['gitlab:apc~server', 'gitlab:apc~ape'])
  })
})
describe('where a request is submitted', () => {
  it('sends a GitHub or GitLab trigger to its own repository only', () => {
    expect(instanceOf('gitlab:apc~web')).toBe('gitlab:apc~web')
    expect(instanceOf('popo')).toBeUndefined()
    expect(instanceOf('gitlab')).toBeUndefined()
    expect(ids(targetRepositories(settings(), 'gitlab:apc~web'))).toEqual(['gitlab:apc~web'])
    expect(ids(targetRepositories(settings(), 'gitlab:apc~web', ['apc/web']))).toEqual(['gitlab:apc~web'])
    expect(ids(targetRepositories(settings(), 'gitlab:apc~web', ['apc/server']))).toMatch(/own repository only/)
    expect(ids(targetRepositories(settings(), 'github:acme~widgets', ['apc/web', 'acme/widgets']))).toMatch(/own repository only/)
  })
  it('lets a chat trigger name every repository along the chain, once each, and refuses an unknown one', () => {
    expect(ids(targetRepositories(settings(), 'popo', ['apc/web', 'apc/server', 'ape', 'apc/web']))).toEqual(['gitlab:apc~web', 'gitlab:apc~server', 'gitlab:apc~ape'])
    expect(ids(targetRepositories(settings(), 'feishu', ['apc/nowhere']))).toMatch(/not an enabled repository/)
  })
  it('falls back to the first repository when a chat trigger names none, and to none when none is configured', () => {
    expect(ids(targetRepositories(settings(), 'popo'))).toEqual(['github:acme~widgets'])
    expect(ids(targetRepositories({ sources: {} } as never, 'popo'))).toEqual([])
  })
})
describe('the description for the main Session', () => {
  it('lists each repository with its tags and callees, and is empty with none', () => {
    const section = repositoriesSection(settings())
    expect(section).toContain('- apc/server (gitlab:apc~server): backend, gateway; calls apc/ape')
    expect(section).toContain('- apc/web (gitlab:apc~web): frontend; calls apc/server')
    expect(repositoriesSection({ sources: {} } as never)).toBe('')
  })
})
