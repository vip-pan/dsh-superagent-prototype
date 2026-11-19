/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { githubPage, githubRepositoryOf, githubThread, parseThread, UserSchema, type Instance } from './github-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (ctx: SourceContext, instance: Instance, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).githubRepository(instance.repository).api(PullSchema, `pulls/${number}`), number })
/** A PR a ticket follows: its repository instance and number, parsed from a thread key (`<instance>:<number>`). */
export interface FollowedPull { source: string; number: number }
export const followedPull = (thread: string): FollowedPull | undefined => parseThread(thread)
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): FollowedPull[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => followedPull(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): FollowedPull | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
const samePull = (a: FollowedPull, b: FollowedPull): boolean => a.source === b.source && a.number === b.number
/** True when the PR was opened by the agent account from a branch in the instance's repository (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  instance: Instance, deployment: Pick<Deployment, 'github'>): boolean =>
  sameName(pr.user.login, deployment.github?.login ?? '') && sameName(pr.head?.repo?.full_name ?? '', instance.repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, instance: Instance, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === instance.source && source.meta.isPr === true && source.meta.number === pr.number
  const opened = agentPull(pr, instance, ctx.deployment) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const login = ctx.deployment.github?.login ?? ''
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const mine: FollowedPull = { source: instance.source, number: pr.number }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).some(ref => samePull(ref, mine)))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === githubThread(instance.source, pr.number))
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, instance, pr, opened)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket of its instance.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, instance: Instance, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  const thread = githubThread(instance.source, pr.number)
  if (ended) closePull(ctx, instance, pr)
  else {
    const candidates = agentPull(pr, instance, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === thread && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(ref => ref.source !== instance.source || ref.number === pr.number))) claimPull(ctx, ticket.id, instance, pr)
  }
  ctx.threads.describe(thread, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, instance: Instance, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: instance.source, id: String(pr.number) }, own)
    ctx.threads.patch(githubThread(instance.source, pr.number), { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, instance: Instance, pr: Pull): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).some(ref => ref.source === instance.source && ref.number === pr.number))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: instance.source, id: String(pr.number) }, pr.merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && followedPull(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  const ref = follow ? followedPull(follow.thread) : undefined
  const repository = ref ? githubRepositoryOf(ref.source) : undefined
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow || !ref || !repository) return []
  const { number } = ref
  const url = githubPage(repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped.
  return ticket.channels.filter(channel => channel.source !== ref.source).map(channel => ({
    id: key('pr-terminal', follow.thread, channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
