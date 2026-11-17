/** GitLab source kind definition, todo and project polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Thread } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { branchPipelines, mrPipelines, pipelineCounts, pipelineFact, pipelineFailures, pipelineSummary, gitlabThreadContext } from './gitlab-read.ts'
import { branchCiTrigger, issueTrigger, IssueSchema, mrTrigger, MergeRequestSchema, noteTrigger,
  NoteSchema, pipelineCiTrigger, SOURCE, type GitlabKind } from './gitlab-trigger.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { observeMr, mrsOf, readMr, type Mr } from './gitlab-pull.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import { pollFailure } from './github.ts'
import type { Localized, SourceKind } from './kind.ts'
import { z } from 'zod'

/** A pending todo of the agent account; `target` is the Issue or MR it points to. */
const TodoSchema = z.looseObject({
  id: z.number(), created_at: z.string().nullish(), action_name: z.string().nullish(),
  project: z.looseObject({ path_with_namespace: z.string() }),
  target_type: z.string().nullish(), target: z.looseObject({ iid: z.number() }).nullish(),
})

const GitlabConfigSchema = GitlabAccountsSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMrs: z.boolean().default(false), observeComments: z.boolean().default(false),
  observePipelines: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', mrs: 'observeMrs', comments: 'observeComments', ci: 'observePipelines' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'mrs'
  return meta.noteId !== undefined ? 'comments' : undefined
}
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收项目里发给它的待办、已订阅 Issue 与合并请求的讨论、流水线状态变化和合并请求合并关闭。', en: 'The agent\'s GitLab account; receives todos addressed to it in the project, discussion on subscribed Issues and merge requests, pipeline changes, and merge request merge or close.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(?:\\.[A-Za-z0-9_.\\-]+)+', label: { zh: 'GitLab 服务器', en: 'GitLab server' },
      hint: { zh: 'GitLab 实例的域名，例如 gitlab.example.com。保存时检查智能体账号能否推送到项目，然后重启 dsh-superagent。', en: 'The GitLab instance domain, for example gitlab.example.com. Saving checks that the agent account can push to the project, then restarts dsh-superagent.' } },
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/project 的完整路径。这个来源接收这个项目的待办和讨论；保存时检查智能体账号能否推送到它，然后重启 dsh-superagent。', en: 'The full group/project path. This Source receives the project\'s todos and discussion; saving checks that the agent account can push to it, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GITLAB_HOST 登录智能体账号的 glab 包装脚本。智能体以它登录的账号行事，执行器以 glab 调用它。保存时检查它登录的账号能否推送到项目，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account for this host. The agent acts as the account it is signed in to, and the Executor calls it as glab. Saving checks that this account can push to the project, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMrs', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' },
      hint: { zh: '打开后，Issue 和合并请求上没有 @ 智能体的评论和代码评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and diff comments on Issues and merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observePipelines', type: 'switch', label: { zh: '接收默认分支的流水线', en: 'Receive the default branch\'s pipelines' },
      hint: { zh: '打开后，默认分支的流水线失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'Failures of the default branch\'s pipelines, and their recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } }],
  // What the Source observes across the project it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // `#12` names an Issue, `!12` a merge request, and a web URL of either names its thread.
  find: query => {
    const text = query.trim()
    const issue = /^#(\d+)$/.exec(text)
    const mr = /^!(\d+)$/.exec(text)
    const url = /^https?:\/\/[^/]+\/.+\/-\/(issues|merge_requests)\/(\d+)/i.exec(text)
    const threads = issue ? [`issue:${issue[1]}`] : mr ? [`mr:${mr[1]}`]
      : url ? [`${url[1]!.toLowerCase() === 'issues' ? 'issue' : 'mr'}:${url[2]}`] : []
    return { threads, terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收项目里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the project on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mrs', { zh: '新合并请求', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '默认分支的流水线', en: 'Default branch pipelines' }, note: config.observePipelines ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observePipelines } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: '这个来源监听的 GitLab 实例域名。', en: 'The GitLab instance domain this Source watches.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_REPOSITORY', description: { zh: '这个来源监听的项目，group/project。智能体在这里开的合并请求，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The project this Source watches, as group/project. A merge request the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，GitLab 操作都用 glab，不用其他账号或凭据', en: 'The agent\'s GitLab account. glab is signed in to it; use glab for every GitLab operation, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或合并请求编号；工单不是从 GitLab 来的时为空', en: 'IID of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的合并请求的 head 引用 refs/merge-requests/<编号>/head；不是合并请求时为空', en: 'Head ref refs/merge-requests/<iid>/head of the merge request that started the ticket; empty when it was not a merge request' } },
    ],
    values: ({ deployment, trigger }) => {
      const mine = trigger?.threads[0]?.source === SOURCE
      const iid = mine ? Number(trigger.meta.iid) || 0 : 0
      return { DSH_SUPERAGENT_GITLAB_HOST: deployment.gitlab?.host ?? '', DSH_SUPERAGENT_GITLAB_REPOSITORY: deployment.gitlab?.repository ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.gitlab?.noreply ?? '',
        DSH_SUPERAGENT_GITLAB_IID: iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: iid && mine && trigger?.meta.kind === 'mr' ? `refs/merge-requests/${iid}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined
  mrs: Map<number, Promise<Mr>>; read: Set<string>; failures: string[]; dropped: string[]; abandoned: string[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, mrs: new Map(), read: new Set(),
  failures: [], dropped: [], abandoned: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
export interface GitlabRetry { since: string; mr: boolean; failedAt?: string; attempts?: number }
const RETRY_WINDOW_MS = 24 * 3600_000
/** True when GitLab reports the Issue or MR gone (410) or not found (404), its usual reply for deleted targets. */
const deleted = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** Records a failed read on the Thread and in the round; deleted or abandoned (24h+) threads do not fail the round. */
function failed(ctx: SourceContext, round: Round, thread: string, error: unknown, abandoned = false): void {
  if (deleted(error)) round.dropped.push(thread)
  else if (abandoned) round.abandoned.push(thread)
  else round.failures.push(`${thread}: ${String(error)}`)
  ctx.threads.patch(`${SOURCE}:${thread}`, { pollError: String(error) })
}
/** Project-wide streams of new Issues, new merge requests, and comments on updated ones. */
const STREAMS = [
  { id: 'issues', observed: (config: GitlabConfig) => config.observeIssues, path: 'issues?state=all&order_by=updated_at&sort=asc' },
  { id: 'mrs', observed: (config: GitlabConfig) => config.observeMrs, path: 'merge_requests?state=all&order_by=updated_at&sort=asc' },
  { id: 'comments', observed: (config: GitlabConfig) => config.observeComments, path: 'issues?order_by=updated_at&sort=asc' },
  { id: 'mr-comments', observed: (config: GitlabConfig) => config.observeComments, path: 'merge_requests?order_by=updated_at&sort=asc' },
] as const
/**
 * Polls project-wide streams since their cursors, relying on Trigger ID deduplication so repeated items are no-ops. Each
 * stream reads from when it was switched on, resets when switched off, and fails independently. New Issues and merge
 * requests become Triggers; the comment streams re-read the notes of every recently updated Issue or merge request.
 */
async function pollStreams(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    if (!stream.observed(config)) { ctx.state.set(KV.gitlab.stream(stream.id), undefined); continue }
    try { await readStream(ctx, round, stream.id, stream.path, config) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream.id}: ${String(error)}`) }
  }
  // When pipeline observation is turned off, clear the failure baseline but preserve the revision counter so future triggers have unique IDs.
  if (!config.observePipelines) {
    const seen = ctx.state.get(KV.gitlab.branchCi)
    ctx.state.set(KV.gitlab.branchCi, seen && { revision: seen.revision })
    return
  }
  try { await pollBranchPipelines(ctx, round) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`default branch pipelines: ${String(error)}`) }
}
/** Reads one project-wide stream (oldest first), stepping its cursor to five seconds before the newest item (`cursorAt`). */
async function readStream(ctx: SourceContext, round: Round, id: string, path: string, config: GitlabConfig): Promise<void> {
  const name = KV.gitlab.stream(id)
  const stored = ctx.state.get(name)
  const kind = id === 'issues' ? 'issues' : id === 'mrs' ? 'mrs' : 'comments'
  const before = typeof stored?.started === 'object' ? stored.started : {}
  const started: Record<string, string> = { [kind]: before[kind] ?? round.started }
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString()
  const listed = `${path}&updated_after=${encodeURIComponent(since)}&per_page=50`
  const items = id === 'issues' || id === 'comments'
    ? await validItems(IssueSchema, await ctx.commands.withSignal(round.signal).gitlabApi(z.array(z.unknown()), listed), round.tally)
    : await validItems(MergeRequestSchema, await ctx.commands.withSignal(round.signal).gitlabApi(z.array(z.unknown()), listed), round.tally)
  const { login } = ctx.deployment.gitlab!
  const fresh = (at: string | null | undefined) => Date.parse(at ?? '') >= Math.max(Date.parse(started[kind]!), horizon)
  for (const item of items) {
    // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    if (sameName(item.author.username ?? '', login)) continue
    if (id === 'issues' || id === 'mrs') {
      if (!fresh(item.created_at)) continue
      await ctx.receive(id === 'issues' ? issueTrigger(item, login) : mrTrigger(item, login))
      nameThread(ctx, id === 'issues' ? 'issue' : 'mr', item.iid, item.title)
      continue
    }
    // A comment stream re-reads the notes of every updated Issue or merge request from its own thread cursor.
    const thread = id === 'comments' ? 'issue' : 'mr'
    const checkpoint = KV.gitlab.cursor(`${thread}:${item.iid}`)
    await intakeNotes(ctx, { kind: thread, iid: item.iid, ...thread === 'mr' ? { url: item.web_url, mrAuthor: item.author.username ?? '' } : { url: item.web_url } },
      ctx.state.get(checkpoint) ?? since, round)
  }
  const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? item.created_at ?? '')).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  const next = Date.parse(moved) > Date.parse(since) ? moved : since
  ctx.state.set(name, { since: next, started })
}
/** Polls default-branch pipelines, emitting a trigger only when the set of failing pipelines changes after the initial baseline. */
async function pollBranchPipelines(ctx: SourceContext, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const project = await commands.gitlabApi(z.looseObject({ default_branch: z.string().nullish(), web_url: z.string() }), '')
  const branch = project.default_branch ?? 'main'
  const pipelines = await branchPipelines(commands, branch, round.tally)
  const previous = ctx.state.get(KV.gitlab.branchCi)
  // The first observation after switching on or renaming the default branch establishes the baseline.
  const known = previous?.branch === branch ? previous.failures : undefined
  const failures = pipelineFailures(pipelines)
  const counts = pipelineCounts(pipelines)
  // Retain previous failures while pipelines are still running so recovery is reported only once all pipelines pass.
  const now = failures.length || !counts.running ? failures : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const newest = pipelines[0]
    const summary = pipelineSummary(pipelines, branch, 'the project\'s pipeline list')
    const url = `${project.web_url}/-/pipelines${newest?.id ? `/${newest.id}` : ''}`
    await ctx.receive(branchCiTrigger(branch, newest?.sha ?? '', revision, summary, url))
    ctx.threads.describe(`${SOURCE}:ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: pipelineFact(counts) } })
  }
  ctx.state.set(KV.gitlab.branchCi, { branch, failures: now, revision })
}
/**
 * One polling round: todos, then observed project streams, then the merge requests of open tickets with their pipelines,
 * then subscribed Threads. Each step and each Issue, merge request, or Thread fails independently so all steps run before
 * the round fails. Other read failures fail the round toward the error threshold, whereas deleted or abandoned (24h+)
 * threads are recorded only on the thread and in health detail.
 * @returns the polling interval in seconds; GitLab names none, so this is always 60.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const notified = await pollTodos(ctx, round).then(value => ({ value }), (error: unknown) => ({ error }))
  await pollStreams(ctx, round)
  await pollTicketMrs(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if ('error' in notified) throw notified.error
  const { count } = notified.value
  if (signal?.aborted) return 60
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const named = (threads: string[]) => [...new Set(threads)].sort().join(', ')
  const dropped = (round.dropped.length ? `; deleted on GitLab: ${named(round.dropped)}` : '')
    + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report('gitlab', { state: 'ready', detail: `${count} todos; next poll ≥ 60s${dropped}`, at: round.started })
  return 60
}
/** Reads todos since the cursor and each Issue or merge request they name, advancing the cursor atomically with the retry map for failed reads. */
async function pollTodos(ctx: SourceContext, round: Round): Promise<{ count: number }> {
  const { state } = ctx
  const commands = ctx.commands.withSignal(round.signal)
  const since = state.get(KV.gitlab.since) ?? round.started
  if (state.get(KV.gitlab.since) === undefined) state.set(KV.gitlab.since, since)
  const { repository } = ctx.deployment.gitlab!
  // GitLab todos have no `since` filter; pending todos are read in full and filtered by creation time.
  const todos = await commands.gitlabPages(TodoSchema, 'todos?per_page=100', round.tally)
  const retries = { ...state.get(KV.gitlab.retries) }
  // Failed items from the previous round run first, followed by new todos in chronological order; each is read once.
  const items = new Map(Object.entries(retries))
  for (const todo of todos.reverse()) {
    if (!sameName(todo.project.path_with_namespace, repository)) continue
    if (Date.parse(todo.created_at ?? '') < Date.parse(since)) continue
    const kind = todo.target_type === 'MergeRequest' ? 'mr' : todo.target_type === 'Issue' ? 'issue' : undefined
    const iid = kind && todo.target ? todo.target.iid : undefined
    if (!kind || !iid) continue
    const thread = `${kind}:${iid}`
    if (!items.has(thread)) {
      const cursor = `${state.get(KV.gitlab.cursor(thread)) ?? since}`
      items.set(thread, { since: [cursor, since].sort().at(-1)!, mr: kind === 'mr' })
    }
  }
  for (const [thread, item] of items) {
    if (stopped(ctx, round)) return { count: todos.length }
    round.read.add(thread)
    try {
      await readNotified(ctx, round, item.mr ? 'mr' : 'issue', Number(thread.slice(thread.indexOf(':') + 1)), item)
      delete retries[thread]
    } catch (error) {
      if (stopped(ctx, round)) return { count: todos.length }
      const retry = { ...item, failedAt: item.failedAt ?? round.started, attempts: (item.attempts ?? 0) + 1 }
      // Abandon todo retries after 24 hours of failures so a permanently unreadable thread does not hold source health in error; its cursor stays so a later todo or thread poll still reads what was missed.
      const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
      failed(ctx, round, thread, error, abandoned)
      if (!deleted(error) && !abandoned) { retries[thread] = retry; continue }
      delete retries[thread]
    }
  }
  ctx.atomic(() => { state.set(KV.gitlab.since, cursorAt(round.started)); state.set(KV.gitlab.retries, retries) })
  return { count: todos.length }
}
async function readNotified(ctx: SourceContext, round: Round, kind: GitlabKind, iid: number, item: GitlabRetry): Promise<void> {
  const { since } = item
  const { login } = ctx.deployment.gitlab!
  if (kind === 'issue') {
    const issue = await ctx.commands.withSignal(round.signal).gitlabApi(IssueSchema, `issues/${iid}`)
    // An Issue opened by someone other than the agent since the cursor brings its body so a mention in it reaches the gate.
    const opened = Date.parse(issue.created_at) >= Date.parse(since) && !sameName(issue.author.username ?? '', login)
    if (opened) await ctx.receive(issueTrigger(issue, login))
    await intakeNotes(ctx, { kind: 'issue', iid, url: issue.web_url }, since, round)
    nameThread(ctx, 'issue', iid, issue.title)
  } else {
    const mr = await mergeRequest(ctx, round, iid)
    // Emit an MR description trigger for MRs opened since the cursor; its ID is the same as the one produced by the project MR stream.
    if (mr.created_at && Date.parse(mr.created_at) >= Date.parse(since) && !sameName(mr.author.username ?? '', login)) {
      await ctx.receive(mrTrigger({ iid, title: mr.title ?? '', body: mr.body, author: mr.author, created_at: mr.created_at,
        web_url: mr.web_url, source_branch: mr.source_branch ?? undefined }, login))
    }
    await intakeNotes(ctx, { kind: 'mr', iid, url: mr.web_url, mrAuthor: mr.author.username ?? '' }, since, round)
    if (mr.title) nameThread(ctx, 'mr', iid, mr.title)
  }
  ctx.state.set(KV.gitlab.cursor(`${kind}:${iid}`), cursorAt(round.started))
  ctx.threads.patch(`${SOURCE}:${kind}:${iid}`, { pollError: undefined })
}
/** Reads and observes a merge request at most once per polling round. */
function mergeRequest(ctx: SourceContext, round: Round, iid: number): Promise<Mr> {
  let read = round.mrs.get(iid)
  if (!read) {
    read = readMr(ctx, iid, round.signal).then(async mr => { await observeMr(ctx, mr); return mr })
    round.mrs.set(iid, read)
  }
  return read
}
/** Reads a thread's notes since `since`, skipping system notes and the agent's own; each becomes a note Trigger. */
async function intakeNotes(ctx: SourceContext, ref: { kind: GitlabKind; iid: number; url?: string; mrAuthor?: string }, since: string, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const { login } = ctx.deployment.gitlab!
  const path = `${ref.kind === 'mr' ? 'merge_requests' : 'issues'}/${ref.iid}/notes?sort=asc&order_by=created_at&per_page=100`
  const notes = await commands.gitlabPages(NoteSchema, path, round.tally)
  for (const note of notes) {
    // Stopping mid-read throws so the thread's cursor stays where it was.
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    const timestamp = Date.parse(note.updated_at ?? note.created_at ?? '')
    if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
    if (note.system) continue
    if (sameName(note.author.username ?? '', login)) continue
    const trigger = noteTrigger(note, ref, login)
    if (trigger.text) await ctx.receive(trigger)
  }
}
export async function pollTicketMrs(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const iids = [...new Set(ctx.tickets.open().flatMap(ticket => mrsOf(ticket, true)))]
  for (const iid of iids) {
    if (stopped(ctx, round)) return
    try {
      const mr = await mergeRequest(ctx, round, iid)
      if (mr.state === 'opened' && !mr.merged) await pollPipelines(ctx, round, iid, mr)
    } catch (error) { if (!stopped(ctx, round)) failed(ctx, round, `mr:${iid}`, error) }
  }
}
/** Polls an MR's pipelines; only changes after the first baseline observation become Triggers. */
async function pollPipelines(ctx: SourceContext, round: Round, iid: number, mr: Mr): Promise<void> {
  const pipelines = await mrPipelines(ctx.commands.withSignal(round.signal), iid, round.tally)
  const fingerprint = key(JSON.stringify(pipelines))
  const previous = ctx.state.get(KV.gitlab.ci(`mr:${iid}`))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) await ctx.receive(pipelineCiTrigger({ iid, web_url: mr.web_url, author: mr.author }, revision,
    pipelineSummary(pipelines, `MR !${iid}`, `gitlab/mrs/${iid}/pipelines`)))
  ctx.state.set(KV.gitlab.ci(`mr:${iid}`), { fingerprint, revision })
  ctx.threads.describe(`${SOURCE}:mr:${iid}`, { facts: { ci: pipelineFact(pipelineCounts(pipelines)) } })
}
function nameThread(ctx: SourceContext, kind: GitlabKind, iid: number, title: string): void {
  ctx.threads.patch(`${SOURCE}:${kind}:${iid}`, { title })
  ctx.threads.describe(`${SOURCE}:${kind}:${iid}`, { label: `${kind === 'mr' ? '!' : '#'}${iid} ${title}`, facts: { iid: { value: `${kind === 'mr' ? '!' : '#'}${iid}` } } })
}
/** Polls subscribed Issue and merge request Threads not already read in this round; deleted targets do not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) round.dropped.push(thread.ref.id); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(String(thread.ref.id)))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // The default branch's pipeline Thread has no Issue or MR to read; its CI arrives as Triggers.
  if (thread.ref.id.startsWith('ci:')) return
  const kind = thread.ref.id.startsWith('mr:') ? 'mr' : thread.ref.id.startsWith('issue:') ? 'issue' : undefined
  const iid = kind ? Number(thread.ref.id.slice(kind.length + 1)) : 0
  if (!kind || !iid) throw new Error('Subscribed thread has no GitLab Issue or merge request iid')
  round.read.add(`${kind}:${iid}`)
  if (typeof thread.meta.title !== 'string') {
    if (kind === 'issue') {
      const issue = await ctx.commands.withSignal(round.signal).gitlabApi(IssueSchema, `issues/${iid}`)
      ctx.threads.patch(thread.key, { iid, isMr: false, url: issue.web_url })
      nameThread(ctx, 'issue', iid, issue.title)
    } else {
      const mr = await ctx.commands.withSignal(round.signal).gitlabApi(MergeRequestSchema, `merge_requests/${iid}`)
      ctx.threads.patch(thread.key, { iid, isMr: true, url: mr.web_url, mrAuthor: mr.author.username ?? '' })
      nameThread(ctx, 'mr', iid, mr.title)
    }
    thread = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = KV.gitlab.cursor(`${kind}:${iid}`)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (kind === 'mr') {
    const mr = await mergeRequest(ctx, round, iid)
    await intakeNotes(ctx, { kind: 'mr', iid, url: mr.web_url, mrAuthor: mr.author.username ?? '' }, since, round)
  } else await intakeNotes(ctx, { kind: 'issue', iid }, since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
