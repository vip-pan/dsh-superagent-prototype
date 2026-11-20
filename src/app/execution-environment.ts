/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import { clonePath, cloneUrl, nodeOf, repositoryNodes } from '../repositories.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY', ticket: true, description: { zh: '这个工单改动的仓库，GitLab 是 group/project，GitHub 是 owner/name；工单没有仓库时为空', en: 'The repository this ticket changes, as group/project on GitLab or owner/name on GitHub; empty when the ticket has none' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY_PATH', ticket: true, description: { zh: '这个仓库的本地克隆目录，来自来源设置里的本地克隆地址；工单的 worktree 从它创建。目录不存在时准备命令要先克隆', en: 'The local clone of that repository, from the Source setting; the ticket\'s worktree is created from it. The prepare command clones it first when it is missing' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY_URL', ticket: true, description: { zh: '克隆这个仓库用的地址', en: 'The URL to clone that repository from' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

/** The repository variables of a ticket: its repository, the clone its worktree comes from, and the URL to clone it from. */
function repositoryValues(deployment: Deployment, settings: Settings, id: string | undefined): Record<string, string> {
  const node = id ? nodeOf(repositoryNodes(settings), id) : undefined
  if (!node) return { DSH_SUPERAGENT_REPOSITORY: '', DSH_SUPERAGENT_REPOSITORY_PATH: '', DSH_SUPERAGENT_REPOSITORY_URL: '' }
  return { DSH_SUPERAGENT_REPOSITORY: node.repository, DSH_SUPERAGENT_REPOSITORY_PATH: clonePath(node, deployment.stateDir),
    DSH_SUPERAGENT_REPOSITORY_URL: cloneUrl(node, deployment.gitlab?.host ?? '') }
}
export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string; repository?: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id, ...repositoryValues(deployment, settings, ticket.repository) } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  // A ticket's repository decides the GitHub or GitLab instance its variables describe, ahead of the Source its trigger came from.
  for (const { kind, environment, config } of sources.environments(settings, ticket?.repository ?? trigger?.source)) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '', ...ticket.repository ? { repository: ticket.repository } : {} }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
