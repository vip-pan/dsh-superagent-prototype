/** Normalizes GitHub issues, pull requests, comments, reviews, and CI transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'github'
/** Instance ID of one configured repository: `github:<owner>~<name>` (`~` cannot appear in a GitHub owner or repository name). */
export const githubInstanceId = (repository: string): string => `${SOURCE}:${repository.replaceAll('/', '~')}`
/** Inverse of `githubInstanceId`; undefined for the plain account key or any other kind. */
export function githubRepositoryOf(source: string): string | undefined {
  if (!source.startsWith(`${SOURCE}:`)) return undefined
  const name = source.slice(SOURCE.length + 1)
  return name ? name.split('~').join('/') : undefined
}
/** Identifies the repository instance every trigger of one poll belongs to. */
export interface Instance { source: string; repository: string }
/** An Issue or PR thread of one instance: its `<instance>:<number>` key, which `parseThread` takes apart. */
export const githubThread = (source: string, number: number): string => `${source}:${number}`
/** Parses `github:<owner>~<name>:<number>`; branch CI threads (`<instance>:ci:<branch>`) have no number and return undefined. */
export function parseThread(thread: string): { source: string; number: number } | undefined {
  const match = /^(github:[A-Za-z0-9_.-]+~[A-Za-z0-9_.-]+):(\d+)$/.exec(thread)
  return match ? { source: match[1]!, number: Number(match[2]) } : undefined
}
/** GitHub reply address: issue/PR conversation of one repository instance, or a review thread when `url` points at a discussion comment. */
export const githubChannel = (instance: Instance, number: number, url?: string): ChannelRef =>
  ({ source: instance.source, thread: githubThread(instance.source, number),
    address: { number: String(number), repository: instance.repository, ...(url ? { url } : {}) } })
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${number}`
/** Parses a web or API URL for an Issue, PR, or review comment in `repository`; returns undefined for other URLs or repositories. */
export function githubAddress(url: string, repository: string): { number: number; pr: boolean; discussion?: number } | undefined {
  const address = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues', ...match[4] ? { discussion: Number(match[4]) } : {} }
}
/** GitHub returns a deleted account as `null` and displays it as `ghost`. */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/**
 * A GitHub comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
 * line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>
/** An Issue as `issues/<number>` returns it; GitHub sets `pull_request` when the number is a pull request. */
export const IssueSchema = CommentSchema.extend({
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
export interface PullRef { number: number; isPr: boolean; url?: string; prAuthor?: string }
/**
 * True when GitHub reports the account as a regular user rather than a bot or GitHub App.
 * Review bots running under ordinary user accounts count as human here; the prompts identify which accounts are automated.
 */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
/** Formats an inline review comment's file:line and the trailing lines of its diff hunk, which GitHub ends at the commented line. */
export function reviewPlace(comment: GithubComment): string {
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${line}` : ''}`, hunk].filter(Boolean).join('\n')
}
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
// The actor belongs to the instance, whose Policy part lists who may originate work there.
// The agent's own account is an ordinary author here: `ownSkipped` already dropped what it must not hear (its replies, its PRs),
// and the Policy's list and admission table decide the rest.
const author = (instance: Instance, user: { login: string; type?: string }) =>
  ({ actor: { source: instance.source, id: user.login }, human: isHumanLogin(user) })
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
export function commentTrigger(instance: Instance, comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = key('github-comment', comment.html_url ?? githubThread(instance.source, ref.number), String(comment.id), version)
  return { id, source: instance.source, threads: [{ source: instance.source, id: String(ref.number) }], ...author(instance, comment.user), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(instance, ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, repository: instance.repository, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
}
/**
 * Builds the trigger for a newly opened Issue's title and body, keyed by its repository instance.
 */
export function issueTrigger(instance: Instance, issue: Opened, agent: string): Trigger {
  const body = issue.body ?? ''
  return { id: key('github-issue', instance.source, String(issue.number)), source: instance.source,
    threads: [{ source: instance.source, id: String(issue.number) }], ...author(instance, issue.user), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(instance, issue.number, issue.html_url), url: issue.html_url,
    meta: { number: issue.number, isPr: false, kind: 'issue', repository: instance.repository } }
}
/**
 * Builds the trigger for a newly opened PR's title and description.
 * PR and Issue numbers share one sequence in a repository and never collide, so this reuses `issueTrigger`'s `github-issue` ID format.
 */
export function pullTrigger(instance: Instance, pull: Opened, agent: string): Trigger {
  return { ...issueTrigger(instance, pull, agent),
    meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull', repository: instance.repository } }
}
/** Builds a trigger for a default-branch CI transition; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(instance: Instance, branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('github-ci', instance.source, `branch:${branch}`, String(revision)), source: instance.source,
    threads: [{ source: instance.source, id: `ci:${branch}` }], actor: { source: instance.source, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision, repository: instance.repository } }
}
export function ciTrigger(instance: Instance, pr: { number: number; html_url: string; user: { login: string } }, revision: number,
  summary: string): Trigger {
  return { id: key('github-ci', instance.source, String(pr.number), String(revision)), source: instance.source,
    threads: [{ source: instance.source, id: String(pr.number) }],
    actor: { source: instance.source, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: githubChannel(instance, pr.number), url: pr.html_url,
    meta: { number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision, repository: instance.repository } }
}
