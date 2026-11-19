/**
 * The repositories dsh-superagent works on: every enabled GitHub or GitLab instance with its local clone, tags, and the
 * repositories it calls, and the rules that decide which of them a request is submitted to.
 */
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { Settings } from './policy.ts'
import type { FieldSpec } from './sources/kind.ts'

/** The kinds whose instances are repositories. */
export const REPOSITORY_KINDS = ['github', 'gitlab'] as const
export type RepositoryKind = typeof REPOSITORY_KINDS[number]

/** Configuration every repository instance card shares: where its clone lives, what it is, and what it calls. */
export const RepositoryShape = {
  localPath: z.string().trim().max(500).refine(path => path === '' || isAbsolute(path), 'An absolute path').default(''),
  tags: z.string().trim().max(300).default(''),
  calls: z.string().trim().max(1000).default(''),
}

/** Panel fields of the shared repository configuration, listed after the repository itself. */
export function repositoryFields(): FieldSpec[] {
  return [
    { key: 'localPath', type: 'text', pattern: '(?:/.*)?', label: { zh: '本地克隆地址', en: 'Local clone' },
      hint: { zh: '这个仓库在本机的克隆目录，绝对路径。工单的 worktree 从它创建，准备命令里用 $DSH_SUPERAGENT_REPOSITORY_PATH 读取。目录不存在时准备命令按 $DSH_SUPERAGENT_REPOSITORY_URL 克隆到这里；留空则放在状态目录的 clones 下。',
        en: 'Absolute path of this repository\'s clone on this machine. Ticket worktrees are created from it; the prepare command reads it as $DSH_SUPERAGENT_REPOSITORY_PATH and clones $DSH_SUPERAGENT_REPOSITORY_URL there when it is missing. Empty keeps the clone under the state directory\'s clones.' } },
    { key: 'tags', type: 'text', label: { zh: '标签', en: 'Tags' },
      hint: { zh: '这个仓库在系统里的角色，用逗号分隔多个，例如 后端服务, 网关转发。需求研判按标签判断哪些仓库要改。', en: 'The roles this repository plays in the system, separated by commas, such as backend, gateway. Request assessment uses them to decide which repositories change.' } },
    { key: 'calls', type: 'text', label: { zh: '调用的仓库', en: 'Calls' },
      hint: { zh: '这个仓库直接调用或转发流量给的仓库，写仓库名，用逗号分隔。链路从调用方指向被调用方，例如 apc-server 调用 art-proposal-evaluation。', en: 'The repositories this one calls or forwards traffic to, written as repository names separated by commas. The chain runs from caller to callee.' } },
  ]
}

/** One enabled repository with its configuration resolved. */
export interface RepositoryNode {
  /** The instance key in settings, such as `gitlab:group~name`. */
  id: string
  kind: RepositoryKind
  repository: string
  /** The configured clone, or empty for the default under the state directory. */
  localPath: string
  tags: string[]
  /** Repositories this one calls, as written. */
  calls: string[]
}
/** Splits a comma, semicolon, or newline separated list. */
export const splitList = (text: unknown): string[] => typeof text === 'string'
  ? [...new Set(text.split(/[,，;；\n]+/).map(item => item.trim()).filter(Boolean))] : []
const kindOf = (id: string): RepositoryKind | undefined => REPOSITORY_KINDS.find(kind => id.startsWith(kind + ':'))

/** The enabled repository instances, in key order; none for a kind whose account is off. */
export function repositoryNodes(settings: Pick<Settings, 'sources'>): RepositoryNode[] {
  return Object.entries(settings.sources).sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, value]): RepositoryNode[] => {
    const kind = kindOf(id)
    const repository = typeof value.config.repository === 'string' ? value.config.repository : ''
    if (!kind || !repository || value.enabled === false || settings.sources[kind]?.enabled === false) return []
    return [{ id, kind, repository, localPath: typeof value.config.localPath === 'string' ? value.config.localPath : '',
      tags: splitList(value.config.tags), calls: splitList(value.config.calls) }]
  })
}
/** Whether `source` is the instance of a repository, which a trigger from it belongs to. */
export const instanceOf = (source: string): string | undefined => kindOf(source) && source.includes(':') && source.length > source.indexOf(':') + 1
  ? source : undefined
/** The directory name that holds a repository's ticket directories: its instance name, such as `group~name`. */
export const repositoryDirectory = (id: string): string => id.slice(id.indexOf(':') + 1) || id

/** The node a written repository name or instance key refers to. */
export function nodeOf(nodes: readonly RepositoryNode[], name: string): RepositoryNode | undefined {
  const wanted = name.trim().toLowerCase()
  return nodes.find(node => node.id.toLowerCase() === wanted || node.repository.toLowerCase() === wanted)
    ?? nodes.filter(node => node.repository.toLowerCase().split('/').at(-1) === wanted).find((_, index, all) => all.length === 1)
}
/** The clone of a repository: the configured path, else a directory under the state directory. */
export const clonePath = (node: Pick<RepositoryNode, 'id' | 'localPath'>, stateDir: string): string => node.localPath
  || join(stateDir, 'clones', repositoryDirectory(node.id))
/** The URL its clone is fetched from: the GitLab host's, or github.com. */
export const cloneUrl = (node: Pick<RepositoryNode, 'kind' | 'repository'>, gitlabHost: string): string => node.kind === 'gitlab'
  ? `https://${gitlabHost}/${node.repository}.git` : `https://github.com/${node.repository}.git`

/** The repositories directly or transitively called from `node`, and those calling it. */
export function chainOf(nodes: readonly RepositoryNode[], node: RepositoryNode): { downstream: RepositoryNode[]; upstream: RepositoryNode[] } {
  const edges = (from: RepositoryNode) => from.calls.flatMap(name => nodeOf(nodes, name) ?? [])
  const walk = (start: RepositoryNode, next: (item: RepositoryNode) => RepositoryNode[]): RepositoryNode[] => {
    const seen = new Set([start.id]), found: RepositoryNode[] = []
    for (const queue = [start]; queue.length;) for (const item of next(queue.shift()!)) {
      if (seen.has(item.id)) continue
      seen.add(item.id); found.push(item); queue.push(item)
    }
    return found
  }
  return { downstream: walk(node, edges), upstream: walk(node, item => nodes.filter(other => edges(other).some(callee => callee.id === item.id))) }
}

/**
 * The repositories a request is submitted to. A trigger from a GitHub or GitLab repository is about that repository only,
 * whatever is asked; from any other Source (POPO, Feishu) the request names the repositories along the chain it changes, or,
 * naming none, the first repository. Fails with the reason when a named repository is not an enabled one, or a repository
 * Source's request names another.
 */
export function targetRepositories(settings: Pick<Settings, 'sources'>, source: string, requested: readonly string[] = []):
  { ids: string[] } | { error: string } {
  const nodes = repositoryNodes(settings)
  const own = instanceOf(source)
  if (own) {
    if (requested.some(name => nodeOf(nodes, name)?.id !== own)) return { error: `A request from ${own} is about its own repository only; it cannot be submitted to ${requested.join(', ')}` }
    return { ids: [own] }
  }
  if (!requested.length) return nodes.length ? { ids: [nodes[0]!.id] } : { ids: [] }
  const ids: string[] = []
  for (const name of requested) {
    const node = nodeOf(nodes, name)
    if (!node) return { error: `${name} is not an enabled repository; the enabled ones are ${nodes.map(item => item.repository).join(', ') || 'none'}` }
    if (!ids.includes(node.id)) ids.push(node.id)
  }
  return { ids }
}

/** The main Session's description of the repositories and their chain; empty while none is configured. */
export function repositoriesSection(settings: Pick<Settings, 'sources'>): string {
  const nodes = repositoryNodes(settings)
  if (!nodes.length) return ''
  const lines = nodes.map(node => {
    const callees = node.calls.map(name => nodeOf(nodes, name)?.repository ?? name)
    return `- ${node.repository} (${node.id})${node.tags.length ? ': ' + node.tags.join(', ') : ''}${callees.length ? '; calls ' + callees.join(', ') : ''}`
  })
  return ['Repositories this installation develops, with their roles and the repositories each calls (traffic and calls run from a repository to the ones it calls):',
    ...lines,
    'A request from GitHub or GitLab is about the repository it came from only. A request from POPO or Feishu is about the system: follow the chain from where the request lands to every repository it changes, and accept it once with repositories listing each of them, so that none is missed. Name only repositories the request needs to change.'].join('\n')
}
