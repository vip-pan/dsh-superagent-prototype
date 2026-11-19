/** Normalizes GitLab issues, merge requests, notes, and pipeline transitions into domain Triggers, keyed by project instance. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** A GitLab thread: issues and merge requests have independent `iid` sequences, so the kind prefixes the thread ID. */
export type GitlabKind = 'issue' | 'mr'
/** Instance ID of one configured project: `gitlab:<group>~<sub>~<name>` (`~` cannot appear in a GitLab path segment). */
export const gitlabInstanceId = (repository: string): string => `${SOURCE}:${repository.replaceAll('/', '~')}`
/** Inverse of `gitlabInstanceId`; undefined for the plain account key or any other kind. */
export function gitlabRepositoryOf(source: string): string | undefined {
  if (!source.startsWith(`${SOURCE}:`)) return undefined
  const name = source.slice(SOURCE.length + 1)
  return name ? name.split('~').join('/') : undefined
}
export const gitlabThread = (kind: GitlabKind, iid: number): string => `${kind}:${iid}`
/** GitLab reply address: the issue or merge request conversation of one project instance. */
export const gitlabChannel = (source: string, project: string, kind: GitlabKind, iid: number): ChannelRef =>
  ({ source, thread: `${source}:${gitlabThread(kind, iid)}`, address: { project, kind, iid: String(iid) } })
/** Parses a web or API URL for an Issue or MR in `repository`; returns undefined for other URLs or projects. */
export function gitlabAddress(url: string, repository: string): { iid: number; kind: GitlabKind } | undefined {
  const address = /^https?:\/\/([^/]+)\/([^/]+(?:\/[^/]+)*)\/-\/(issues|merge_requests)\/(\d+)/i
  const match = address.exec(url)
  if (!match || !sameName(match[2]!, repository)) return undefined
  return { kind: match[3]!.toLowerCase() === 'issues' ? 'issue' : 'mr', iid: Number(match[4]) }
}
/** GitLab reports deleted accounts as an empty username and displays them as the numeric ID. */
export const UserSchema = z.looseObject({ username: z.string().nullish(), id: z.number() }).nullable()
  .transform(user => user ?? { username: 'ghost', id: 0 })
/** A GitLab note on an issue or merge request; inline diff notes carry `position` with file and line. */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema, created_at: z.string().nullish(), updated_at: z.string().nullish(),
  system: z.boolean().nullish(), resolvable: z.boolean().nullish(), discussion_id: z.string().nullish(),
  position: z.looseObject({
    new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().nullish(), old_line: z.number().nullish(),
    base_sha: z.string().nullish(), head_sha: z.string().nullish(), start_sha: z.string().nullish(),
    position_type: z.string().nullish(),
  }).nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/** GitLab names the text of an Issue or merge request `description`, and the text of a note `body`; both are read as `body`. */
export const withBody = <T extends { body?: string | null; description?: string | null }>(item: T): T => ({ ...item, body: item.body ?? item.description })
/** An Issue as `projects/<id>/issues/<iid>` returns it, before `description` is read as `body`. */
export const IssueFields = NoteSchema.extend({
  iid: z.number(), title: z.string(), state: z.string(), created_at: z.string(), web_url: z.string(), description: z.string().nullish(),
}).omit({ id: true })
export const IssueSchema = IssueFields.transform(withBody)
/** A Merge Request as `projects/<id>/merge_requests/<iid>` returns it, before `description` is read as `body`. */
export const MergeRequestFields = NoteSchema.extend({
  iid: z.number(), title: z.string(), state: z.string(), created_at: z.string(), web_url: z.string(), description: z.string().nullish(),
  source_branch: z.string().nullish(), sha: z.string().nullish(), merge_status: z.string().nullish(),
  detailed_merge_status: z.string().nullish(),
}).omit({ id: true })
export const MergeRequestSchema = MergeRequestFields.transform(withBody)
export type GitlabIssue = z.infer<typeof IssueSchema>
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
type Opened = Pick<GitlabIssue, 'iid' | 'title' | 'body' | 'author' | 'created_at' | 'web_url'>
export interface NoteRef { kind: GitlabKind; iid: number; url?: string; mrAuthor?: string }
/** Identifies the project instance every trigger of one poll belongs to. */
export interface Instance { source: string; project: string }
/** True when GitLab reports the account as a regular user rather than a bot. */
export const isHumanLogin = (user: { username?: string | null }): boolean =>
  !!(user.username ?? '') && !/\(bot\)$|_bot_/i.test(user.username ?? '')
/** Formats an inline diff note's file:line. GitLab notes carry no diff hunk, so the position SHA range stands in. */
export function notePlace(note: GitlabNote): string {
  const position = note.position
  if (!position) return ''
  const path = position.new_path ?? position.old_path
  const line = position.new_line ?? position.old_line
  return path ? [`${path}${line != null ? `:${line}` : ''}`, `range ${position.start_sha ?? '?'}…${position.head_sha ?? '?'}`].join('\n') : ''
}
function noteText(note: GitlabNote): string {
  return [notePlace(note), note.body ?? ''].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
// The actor belongs to the instance, whose Policy part lists who may originate work there.
// The agent's own account is an ordinary author here: `ownSkipped` already dropped what it must not hear (its replies, its merge
// requests), and the Policy's list and admission table decide the rest.
const author = (instance: Instance, user: { username?: string | null; id?: number }) =>
  ({ actor: { source: instance.source, id: user.username ?? '' }, human: !!(user.username ?? '') })
/** Builds a trigger for a note; system notes (label changes and the like) are skipped by callers. */
export function noteTrigger(instance: Instance, note: GitlabNote, ref: NoteRef, agent: string): Trigger {
  const at = note.updated_at ?? note.created_at ?? new Date().toISOString()
  const version = note.updated_at ?? ''
  const id = key('gitlab-note', instance.source, gitlabThread(ref.kind, ref.iid), String(note.id), version)
  return { id, source: instance.source, threads: [{ source: instance.source, id: gitlabThread(ref.kind, ref.iid) }],
    ...author(instance, note.author), at,
    text: noteText(note),
    ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(instance.source, instance.project, ref.kind, ref.iid),
    ...(ref.url ? { url: ref.url } : {}),
    meta: { kind: ref.kind, iid: ref.iid, project: instance.project, ...(ref.kind === 'mr' && ref.mrAuthor ? { mrAuthor: ref.mrAuthor } : {}),
      noteId: note.id,
      ...note.position?.new_path || note.position?.old_path
        ? { path: note.position?.new_path ?? note.position?.old_path!, line: note.position?.new_line ?? note.position?.old_line ?? null }
        : {} } }
}
/** Builds the trigger for a newly opened Issue's title and description. */
export function issueTrigger(instance: Instance, issue: Opened, agent: string): Trigger {
  const body = issue.body ?? ''
  return { id: key('gitlab-issue', instance.source, String(issue.iid)), source: instance.source,
    threads: [{ source: instance.source, id: gitlabThread('issue', issue.iid) }], ...author(instance, issue.author), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(instance.source, instance.project, 'issue', issue.iid), url: issue.web_url,
    meta: { kind: 'issue', iid: issue.iid, project: instance.project } }
}
/** Builds the trigger for a newly opened Merge Request's title and description. */
export function mrTrigger(instance: Instance, mr: Opened & Pick<GitlabMergeRequest, 'source_branch'>, agent: string): Trigger {
  return { ...issueTrigger(instance, mr, agent), channel: gitlabChannel(instance.source, instance.project, 'mr', mr.iid), url: mr.web_url,
    meta: { kind: 'mr', iid: mr.iid, project: instance.project, ...(mr.author.username ? { mrAuthor: mr.author.username } : {}),
      ...(mr.source_branch ? { sourceBranch: mr.source_branch } : {}) } }
}
/** Builds a trigger for a default-branch pipeline transition; branch pipelines have no person to reply to, so they have no `channel`. */
export function branchCiTrigger(instance: Instance, branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitlab-ci', instance.source, `branch:${branch}`, String(revision)), source: instance.source,
    threads: [{ source: instance.source, id: `ci:${branch}` }], actor: { source: instance.source, id: '' }, human: false,
    at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision, project: instance.project } }
}
export function pipelineCiTrigger(instance: Instance, mr: Pick<GitlabMergeRequest, 'iid' | 'web_url' | 'author'>, revision: number,
  summary: string): Trigger {
  return { id: key('gitlab-ci', instance.source, gitlabThread('mr', mr.iid), String(revision)), source: instance.source,
    threads: [{ source: instance.source, id: gitlabThread('mr', mr.iid) }],
    actor: { source: instance.source, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: gitlabChannel(instance.source, instance.project, 'mr', mr.iid), url: mr.web_url,
    meta: { kind: 'mr', iid: mr.iid, project: instance.project, ...(mr.author.username ? { mrAuthor: mr.author.username } : {}), ci: true, revision } }
}
