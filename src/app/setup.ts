/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { INSTANCE_SETUP_FIELDS, SETUP_FIELDS, resolveDeployment, resolveFeishuBot, resolveGitlab, resolveGitlabProject, resolvePopo, workerProbe, type Deployment, type Machine } from '../deployment.ts'
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

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
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
    // One GitLab instance's project access; `only` restricts the check to that instance's block save.
    const checkGitlabProjects = async (only?: string): Promise<void> => {
      const account = await resolveGitlab(machine, gitlab, probe)
      if (!account) return
      for (const [id, value] of Object.entries(settings.sources)) {
        if (!id.startsWith('gitlab:') || (only !== undefined && id !== only) || value.enabled === false) continue
        const repository = typeof value.config.repository === 'string' ? value.config.repository : ''
        if (repository) await resolveGitlabProject(account, repository, probe)
      }
    }
    const gitlabIntended = Boolean(gitlab.host || gitlab.cli || gitlab.defaultProject)
      || Object.keys(settings.sources).some(id => id.startsWith('gitlab:'))
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, probe)
      : block === 'source:gitlab' ? resolveGitlab(machine, gitlab, probe)
      : block === 'source:popo' ? resolvePopo(machine, settings.sources.popo?.config, probe)
      // A GitLab instance block re-checks its own project; account errors also belong to it.
      : place.startsWith('gitlab:') ? checkGitlabProjects(place)
      // With no GitHub fields and GitLab intended, GitLab alone carries the work repository and its failure is the save's failure.
      : !github.repository && !github.cli && gitlabIntended ? checkGitlabProjects()
      : resolveDeployment(machine, github, probe)
    // Account-level SetupErrors of the saved GitLab instance block also belong to it, so they fail the save.
    await check.catch((error: unknown) => {
      if (error instanceof SetupError && error.place !== place && !(place.startsWith('gitlab:') && error.place === 'gitlab')) return
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
    // (and blocks setup outright when no GitHub repository backs the deployment).
    if (gitlabOutcome.gitlab) {
      for (const [id, value] of Object.entries(settings.sources)) {
        if (!id.startsWith('gitlab:') || value.enabled === false) continue
        const repository = typeof value.config.repository === 'string' ? value.config.repository : ''
        if (!repository) continue
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
    const github = settings.sources.github?.config ?? {}
    const githubSet = Boolean(github.repository || github.cli)
    const deployment: Deployment = githubSet || !(gitlabOutcome.gitlab || gitlabOutcome.error)
      ? await resolveDeployment(machine, github, probe)
      : { ...machine, repository: gitlabOutcome.gitlab?.defaultProject ?? '' }
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}), ...(gitlabOutcome.gitlab ? { gitlab: gitlabOutcome.gitlab } : {}), ...(popo ? { popo } : {}) }
    if (!deployment.github && !resolved.gitlab) {
      // GitLab was intended but unresolved: its failure is the deployment's setup problem.
      throw gitlabOutcome.error!
    }
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
