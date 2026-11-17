/** Read-only GitLab Issue, merge request, note, and pipeline inspection for assessments and workers, scoped to one project. */
import { z } from 'zod'
import type { ThreadFact } from '../core/index.ts'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { IssueSchema, MergeRequestSchema, NoteSchema, isHumanLogin, notePlace, gitlabThread, type GitlabNote, type GitlabKind } from './gitlab-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** The bound `api`/`pages` pair of one configured project, as `Commands.gitlabProject(project)` returns. */
export type GitlabCalls = ReturnType<Commands['gitlabProject']>
export const PipelineSchema = z.looseObject({ id: z.number(), sha: z.string().nullish(), status: z.string().nullish(), ref: z.string().nullish(), web_url: z.string().nullish() })
export interface Pipeline { id: number; sha?: string | null; status?: string | null; ref?: string | null; web_url?: string | null }
/** Pipeline statuses that count as failures; `success` and `skipped` do not, and `manual` waits for a person. */
const FAILING = new Set(['failed', 'canceled'])
const RUNNING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running'])
export function pipelineCounts(pipelines: Pipeline[]): { failed: number; running: number } {
  return { failed: pipelines.filter(pipeline => FAILING.has(pipeline.status ?? '')).length,
    running: pipelines.filter(pipeline => RUNNING.has(pipeline.status ?? '') || pipeline.status === 'manual').length }
}
export function pipelineSummary(pipelines: Pipeline[], where: string, read: string): string {
  const failed = pipelines.filter(pipeline => FAILING.has(pipeline.status ?? ''))
  const running = pipelines.filter(pipeline => RUNNING.has(pipeline.status ?? '') || pipeline.status === 'manual')
  const at = `on ${where}${pipelines[0]?.sha ? ` at ${pipelines[0].sha.slice(0, 7)}` : ''}`
  const names = (list: Pipeline[]) => list.slice(0, 5).map(pipeline => `#${pipeline.id}`).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const still = running.length ? `; ${running.length} still running` : ''
  const line = failed.length ? `CI failed ${failed.length}/${pipelines.length} ${at}: ${names(failed)}${still}`
    : running.length ? `CI running ${running.length}/${pipelines.length} ${at}: ${names(running)}`
      : `CI passed ${pipelines.length}/${pipelines.length} ${at}`
  return `${line}\nRead ${read} for every pipeline.`
}
export function pipelineFailures(pipelines: Pipeline[]): string[] {
  return pipelines.filter(pipeline => FAILING.has(pipeline.status ?? '')).map(pipeline => `#${pipeline.id}`).sort()
}
export function pipelineFact(counts: { failed: number; running: number }): ThreadFact {
  if (counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}

/** Reads the pipelines of an MR (`merge_requests/<iid>/pipelines`); returns the branch pipelines for merge refs without their own. */
export async function mrPipelines(calls: GitlabCalls, iid: number, tally?: Tally): Promise<Pipeline[]> {
  const pages = await validItems(PipelineSchema, await calls.api(z.array(z.unknown()), `merge_requests/${iid}/pipelines?per_page=100`), tally)
  if (pages.length) return pages
  const mr = await calls.api(MergeRequestSchema, `merge_requests/${iid}`)
  return mr.source_branch ? branchPipelines(calls, mr.source_branch, tally) : []
}
/** Reads the newest pipelines of a branch, newest first. */
export async function branchPipelines(calls: GitlabCalls, branch: string, tally?: Tally): Promise<Pipeline[]> {
  const listed = await calls.api(z.array(z.unknown()), `pipelines?ref=${encodeURIComponent(branch)}&sort=desc&order_by=id&per_page=100`)
  return validItems(PipelineSchema, listed, tally)
}

/** Reads a non-hidden file or directory listing from the project's default branch via the GitLab API, mirroring the GitHub repository reads. */
export async function readGitlabRepositoryPath(calls: GitlabCalls, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const project = await calls.api(z.looseObject({ default_branch: z.string().nullish() }), '')
  const ref = project.default_branch ?? 'main'
  if (kind === 'file') {
    const file = await calls.api(z.looseObject({ content: z.string().nullish(), encoding: z.string().nullish() }),
      `repository/files/${parts.map(encodeURIComponent).join('%2F')}?ref=${encodeURIComponent(ref)}`)
    if (file.encoding !== 'base64' || !file.content) throw new Error(`${path} is not readable as a text file`)
    return Buffer.from(file.content, 'base64').toString('utf8')
  }
  const entries = await calls.api(z.array(z.looseObject({ name: z.string(), type: z.string().nullish() })),
    `repository/tree?path=${encodeURIComponent(parts.join('/'))}&ref=${encodeURIComponent(ref)}&per_page=100`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

/** Formats a GitLab note, Issue, or MR as a model-facing ContextMessage, marking bots because bot messages never authorize work. */
function gitlabMessage(item: Pick<GitlabNote, 'author' | 'created_at' | 'updated_at' | 'position'>, text: string, id: string): ContextMessage {
  const line = item.position?.new_line ?? item.position?.old_line
  const path = item.position?.new_path ?? item.position?.old_path
  return { id, from: item.author.username ?? 'ghost', at: item.updated_at ?? item.created_at ?? '', text,
    ...!isHumanLogin(item.author) ? { bot: true } : {},
    ...path ? { path, ...line != null ? { line } : {} } : {} }
}
const NoteThreadSchema = NoteSchema.extend({ web_url: z.string().nullish() })
const DescriptionSchema = IssueSchema.extend({
  labels: z.array(z.looseObject({ title: z.string() })).nullish(), draft: z.boolean().nullish(), merged: z.boolean().nullish(),
  source_branch: z.string().nullish(), target_branch: z.string().nullish(),
})
/** Reads the notes of one discussion: the note with the given ID, then every note sharing its `discussion_id`. */
async function noteThread(calls: GitlabCalls, kind: GitlabKind, iid: number, note: number, tally?: Tally): Promise<GitlabNote[]> {
  const notes = await validItems(NoteThreadSchema, await calls.api(z.array(z.unknown()), `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes?per_page=100`), tally)
  const start = notes.find(item => item.id === note)
  const discussion = start?.discussion_id
  const thread = discussion ? notes.filter(item => item.discussion_id === discussion) : start ? [start] : []
  return thread.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
}
function threadMessages(thread: GitlabNote[], id: (note: GitlabNote) => string): ContextMessage[] {
  const [first] = thread
  return thread.map(item => item === first
    ? gitlabMessage(item, [notePlace(item), item.body ?? ''].filter(Boolean).join('\n\n'), id(item))
    : { ...gitlabMessage(item, item.body ?? '', id(item)), ...first ? { reply_to: id(first) } : {} })
}

/**
 * Reads an Issue or MR, a page of its notes, a note thread, or an MR's pipelines as model-facing
 * `{ id, from, at, text, reply_to?, path?, line? }` messages rather than raw GitLab API records.
 * The project segment is the instance ID's `~`-encoded path, so every resource names its own project.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const match = /^gitlab\/([A-Za-z0-9_.-]+(?:~[A-Za-z0-9_.-]+)*)\/(issues|mrs)\/([1-9]\d*)(?:\/(notes|pipelines|thread)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/<project>/issues/<iid> or gitlab/mrs/<iid>, or append /notes/<page>, /thread/<note-id> or /pipelines (MRs only)')
  const [, encoded, kind, iid, section, page = '1'] = match
  const project = encoded!.replaceAll('~', '/')
  const calls = commands.gitlabProject(project)
  const base = `gitlab/${encoded}`
  const path = kind === 'mrs' ? 'merge_requests' : 'issues'
  if (section === 'pipelines') {
    if (kind !== 'mrs') throw new Error('Pipelines require a merge request')
    if (match[5]) throw new Error('Pipelines do not take a page number')
    const pipelines = await mrPipelines(calls, Number(iid))
    return { pipelines, summary: pipelineSummary(pipelines, `MR !${iid}`, `${base}/mrs/${iid}/pipelines`) }
  }
  if (section === 'thread') {
    if (!match[5]) throw new Error('Name the note thread by one of its notes: gitlab/<project>/<kind>/<iid>/thread/<note-id>')
    const thread = await noteThread(calls, kind === 'mrs' ? 'mr' : 'issue', Number(iid), Number(match[5]))
    if (!thread.length) throw new Error('No note of this Issue or MR has that id')
    return { messages: threadMessages(thread, item => String(item.id)) }
  }
  if (!section) {
    const item = await calls.api(DescriptionSchema, `${path}/${iid}`)
    const branches = item.source_branch && item.target_branch ? { source: item.source_branch, target: item.target_branch } : {}
    const labels = item.labels?.length ? { labels: item.labels.map(label => label.title) } : {}
    return { project, iid: item.iid, title: item.title, state: item.state, ...item.merged ? { merged: true } : {}, ...item.draft ? { draft: true } : {},
      ...branches, ...labels, ...gitlabMessage(item, `${item.title}\n\n${item.body ?? ''}`, item.web_url ?? String(item.iid)) }
  }
  const listed = await calls.api(z.array(z.unknown()), `${path}/${iid}/notes?sort=asc&order_by=created_at&per_page=20&page=${page}`)
  const tally = { skipped: 0 }
  const notes = validItems(NoteThreadSchema, listed, tally)
  const messages = notes.map(note => ({ ...gitlabMessage(note, note.body ?? '', String(note.id)),
    ...note.position ? { path: note.position.new_path ?? note.position.old_path!, line: note.position.new_line ?? note.position.old_line ?? null } : {} }))
  return { messages, ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === 20 ? { next_resource: `${base}/${kind}/${iid}/notes/${Number(page) + 1}` } : {} }
}
/** Reads one page of an Issue or MR conversation (with the description first on page 1), using note IDs as message IDs. */
async function conversationPage(calls: GitlabCalls, kind: GitlabKind, iid: number, page: number) {
  const path = kind === 'mr' ? 'merge_requests' : 'issues'
  const messages: ContextMessage[] = []
  if (page === 1) {
    const item = await calls.api(DescriptionSchema, `${path}/${iid}`)
    messages.push(gitlabMessage(item, `${item.title}\n\n${item.body ?? ''}`, item.web_url ?? gitlabThread(kind, iid)))
  }
  const listed = await calls.api(z.array(z.unknown()), `${path}/${iid}/notes?sort=asc&order_by=created_at&per_page=100&page=${page}`)
  const tally = { skipped: 0 }
  const notes = validItems(NoteThreadSchema, listed, tally)
  messages.push(...notes.map(note => gitlabMessage(note, note.body ?? '', String(note.id))))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}
/**
 * Context reader for a GitLab Trigger: reads the note thread for an inline diff note (whose first note is its root and
 * parent), or the Issue/MR conversation by page otherwise (whose first page is its root and parent).
 * The Trigger's own project (its `meta.project`, carried by every GitLab trigger) scopes every read.
 */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    const project = typeof trigger.meta.project === 'string' ? trigger.meta.project : ''
    if (!project) throw new Error('The GitLab trigger names no project')
    const calls = commands.gitlabProject(project)
    // The default branch's CI has no conversation; its Trigger plus a fresh pipeline summary is its context.
    if (typeof trigger.meta.branch === 'string' && trigger.meta.ci) {
      const pipelines = await branchPipelines(calls, trigger.meta.branch)
      const summary = pipelineSummary(pipelines, `branch ${trigger.meta.branch}`, `${trigger.source}:ci`)
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: `${trigger.text}\n${summary}`, bot: true as const }
      return { messages: [message], body: { status: 'branch_ci', messages: [message] }, status: 'branch_ci' }
    }
    const kind = trigger.meta.kind as GitlabKind
    const iid = Number(trigger.meta.iid)
    if (kind === 'mr' && typeof trigger.meta.commentId === 'number' && trigger.meta.path) {
      const thread = await noteThread(calls, 'mr', iid, trigger.meta.commentId)
      const messages = threadMessages(thread, item => String(item.id))
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'note_thread', messages: read }, status: 'note_thread' }
    }
    const body = await conversationPage(calls, kind, iid, Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}
