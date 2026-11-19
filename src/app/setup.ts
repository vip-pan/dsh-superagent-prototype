/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { INSTANCE_SETUP_FIELDS, SETUP_FIELDS, resolveFeishuBot, resolveGithub, resolveGithubRepository, resolveGitlab, resolveGitlabProject, resolvePopo, workerProbe, type Deployment, type GithubAccount, type Machine, type Probe } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

/** Account fields of every kind plus instance-level fields (such as each GitLab instance's project) drive re-checks and restarts. */
const setupFields = (settings: Settings) =>
  JSON.stringify([Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')),
    Object.entries(settings.sources).filter(([id]) => id.includes(':')).map(([id, value]) => {
      const keys = INSTANCE_SETUP_FIELDS[id.slice(0, id.indexOf(':'))] ?? []
      return keys.map(key => value.config[key] ?? '')
    })])
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/** The enabled repository instances of a multi-instance kind: instance ID and configured repository, optionally only `only`. */
function repositories(settings: Settings, kind: string, only?: string): [id: string, repository: string][] {
  // Instances stored under a Source that is off watch nothing.
  if (settings.sources[kind]?.enabled === false) return []
  return Object.entries(settings.sources).flatMap(([id, value]): [string, string][] => {
    const repository = typeof value.config.repository === 'string' ? value.config.repository : ''
    return id.startsWith(`${kind}:`) && (only === undefined || id === only) && value.enabled !== false && repository ? [[id, repository]] : []
  })
}
/**
 * Resolves the GitHub account. Returns undefined while the GitHub Source names neither a CLI nor an enabled repository,
 * and fails with `agentCliUnset` when repositories are configured without a CLI.
 */
async function githubAccount(machine: Machine, github: unknown, settings: Settings, probe: Probe): Promise<GithubAccount | undefined> {
  const cli = typeof settings.sources.github?.config.cli === 'string' ? settings.sources.github.config.cli.trim() : ''
  if (!cli && repositories(settings, 'github').length) throw new SetupError('agentCliUnset')
  return resolveGithub(machine, github, probe)
}

/**
 * Resolves the GitHub and GitLab accounts with every configured repository, and the optional Feishu and POPO bots, by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  gitlabProblem?: SetupProblem
  popoProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and every optional source are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem && !this.gitlabProblem && !this.popoProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const probe = this.probe()
    const place = block.slice(7)
    const github = settings.sources.github?.config ?? {}
    const gitlab = settings.sources.gitlab?.config ?? {}
    // One GitHub instance's repository access; `only` restricts the check to that instance's block save.
    const checkGithubRepositories = async (only?: string): Promise<void> => {
      const account = await githubAccount(machine, github, settings, probe)
      if (!account) return
      for (const [, repository] of repositories(settings, 'github', only)) await resolveGithubRepository(account, repository, probe)
    }
    // One GitLab instance's project access; `only` restricts the check to that instance's block save.
    const checkGitlabProjects = async (only?: string): Promise<void> => {
      const account = await resolveGitlab(machine, gitlab, probe)
      if (!account) return
      for (const [, repository] of repositories(settings, 'gitlab', only)) await resolveGitlabProject(account, repository, probe)
    }
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, probe)
      : block === 'source:gitlab' ? resolveGitlab(machine, gitlab, probe)
      : block === 'source:github' ? githubAccount(machine, github, settings, probe)
      : block === 'source:popo' ? resolvePopo(machine, settings.sources.popo?.config, probe)
      // An instance block re-checks its own repository; account errors also belong to it.
      : place.startsWith('gitlab:') ? checkGitlabProjects(place)
      : checkGithubRepositories(place.startsWith('github:') ? place : undefined)
    // Account-level SetupErrors of the saved instance block also belong to it, so they fail the save.
    await check.catch((error: unknown) => {
      if (error instanceof SetupError && error.place !== place && error.place !== place.split(':')[0]) return
      throw error
    })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const optional = async <K extends 'feishu' | 'popo'>(place: K, resolve: () => Promise<Deployment[K]>): Promise<Deployment[K]> =>
      resolve().catch((error: unknown) => {
        if (!(error instanceof SetupError)) throw error
        if (place === 'feishu') this.feishuProblem = error.problem
        else this.popoProblem = error.problem
        context.logger.warn(`dsh-superagent leaves ${place} out: %s`, error.message)
        return undefined as Deployment[K]
      })
    // GitLab resolves first: a resolved GitLab project can carry the work repository alone, with no GitHub account at all.
    let gitlabOutcome = await resolveGitlab(machine, settings.sources.gitlab?.config, probe).then(gitlab => ({ gitlab, error: undefined as SetupError | undefined }), (error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.gitlabProblem = error.problem
      context.logger.warn('dsh-superagent leaves gitlab out: %s', error.message)
      return { gitlab: undefined, error }
    })
    // Every enabled GitLab instance's project access is part of setup: an unreadable project degrades to gitlabProblem
    // (and blocks setup outright when no GitHub account backs the deployment).
    if (gitlabOutcome.gitlab) {
      for (const [id, repository] of repositories(settings, 'gitlab')) {
        try { await resolveGitlabProject(gitlabOutcome.gitlab, repository, probe) }
        catch (error) {
          if (!(error instanceof SetupError)) throw error
          this.gitlabProblem = error.problem
          context.logger.warn('dsh-superagent leaves gitlab out: instance %s: %s', id, error.message)
          gitlabOutcome = { gitlab: undefined, error }
          break
        }
      }
    }
    const [feishu, popo] = await Promise.all([
      optional('feishu', () => resolveFeishuBot(machine, settings.sources.feishu?.config, probe)),
      optional('popo', () => resolvePopo(machine, settings.sources.popo?.config, probe)),
    ])
    // A GitHub failure is the deployment's setup problem: the account or any enabled repository must resolve once the Source is in use.
    const github = await githubAccount(machine, settings.sources.github?.config, settings, probe)
    if (github) for (const [, repository] of repositories(settings, 'github')) await resolveGithubRepository(github, repository, probe)
    const resolved: Deployment = { ...machine, ...(github ? { github } : {}), ...(feishu ? { feishu } : {}),
      ...(gitlabOutcome.gitlab ? { gitlab: gitlabOutcome.gitlab } : {}), ...(popo ? { popo } : {}) }
    // Without any repository account, GitLab's failure (when it was intended) or the missing repository is the deployment's setup problem.
    if (!resolved.github && !resolved.gitlab) throw gitlabOutcome.error ?? new SetupError('repositoryUnset')
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
