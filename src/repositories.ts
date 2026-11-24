/**
 * The repositories dsh-superagent works on: every enabled GitHub or GitLab instance with its local clone, and the rules that
 * decide which of them a request is submitted to. What each repository is and how they relate is not held here; the main Session
 * learns it from the knowledge the team connects.
 */
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { Settings } from './policy.ts'
import type { FieldSpec } from './sources/kind.ts'

/** The kinds whose instances are repositories. */
export const REPOSITORY_KINDS = ['github', 'gitlab'] as const
export type RepositoryKind = typeof REPOSITORY_KINDS[number]

/** Configuration every repository instance card shares: where its clone lives. */
export const RepositoryShape = {
  localPath: z.string().trim().max(500).refine(path => path === '' || isAbsolute(path), 'An absolute path').default(''),
}

/** Panel fields of the shared repository configuration, listed after the repository itself. */
export function repositoryFields(): FieldSpec[] {
  return [
    { key: 'localPath', type: 'text', pattern: '(?:/.*)?', label: { zh: '本地克隆地址', en: 'Local clone' },
      hint: { zh: '这个仓库在本机的克隆目录，绝对路径。工单的 worktree 从它创建，准备命令里用 $DSH_SUPERAGENT_REPOSITORY_PATH 读取。目录不存在时准备命令按 $DSH_SUPERAGENT_REPOSITORY_URL 克隆到这里；留空则放在状态目录的 clones 下。',
        en: 'Absolute path of this repository\'s clone on this machine. Ticket worktrees are created from it; the prepare command reads it as $DSH_SUPERAGENT_REPOSITORY_PATH and clones $DSH_SUPERAGENT_REPOSITORY_URL there when it is missing. Empty keeps the clone under the state directory\'s clones.' } },
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
}
const kindOf = (id: string): RepositoryKind | undefined => REPOSITORY_KINDS.find(kind => id.startsWith(kind + ':'))

/** The enabled repository instances, in key order; none for a kind whose account is off. */
export function repositoryNodes(settings: Pick<Settings, 'sources'>): RepositoryNode[] {
  return Object.entries(settings.sources).sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, value]): RepositoryNode[] => {
    const kind = kindOf(id)
    const repository = typeof value.config.repository === 'string' ? value.config.repository : ''
    if (!kind || !repository || value.enabled === false || settings.sources[kind]?.enabled === false) return []
    return [{ id, kind, repository, localPath: typeof value.config.localPath === 'string' ? value.config.localPath : '' }]
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

/**
 * The repositories a request is submitted to. A trigger from a GitHub or GitLab repository is about that repository only,
 * whatever is asked; from any other Source (POPO, Feishu) the request names the repositories it changes, or,
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
