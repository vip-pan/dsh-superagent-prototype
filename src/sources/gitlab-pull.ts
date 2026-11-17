/** Merge request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { SOURCE, UserSchema } from './gitlab-trigger.ts'

const MrSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), web_url: z.string(), author: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  source_branch: z.string().nullish(), sha: z.string().nullish(),
  source_project_id: z.number().nullish(), project_id: z.number().nullish(),
})
export type Mr = z.infer<typeof MrSchema> & { iid: number }
export const readMr = async (ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<Mr> =>
  ({ ...await ctx.commands.withSignal(signal).gitlabApi(MrSchema, `merge_requests/${iid}`), iid })
/** Extracts the merge request `iid` from a GitLab thread ID (`mr:<iid>`); issue and CI threads have none. */
const mrIid = (thread: string): number | undefined => thread.startsWith('mr:') ? Number(thread.slice(3)) : undefined
export const mrsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mrIid(item.thread) ?? [])
export const mrOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => mrsOf(ticket, true).at(-1) ?? mrsOf(ticket).at(-1)
/** True when the MR was opened by the agent account from a branch in the configured project (not a fork). */
export const agentMr = (mr: { author: { username?: string | null }; source_project_id?: number | null; project_id?: number | null },
  deployment: Pick<Deployment, 'gitlab'>): boolean =>
  !!deployment.gitlab && sameName(mr.author.username ?? '', deployment.gitlab.login)
  && mr.source_project_id != null && mr.project_id != null && mr.source_project_id === mr.project_id
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name

/**
 * Validates and binds an open MR to a ticket when the MR is either the ticket's origin MR or an agent-authored MR on the
 * ticket's branch, enforcing that one MR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the MR is bound or when the MR is not open.
 */
export function claimMr(ctx: SourceContext, ticketId: string, mr: Mr): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.kind === 'mr' && source.meta.iid === mr.iid
  const opened = agentMr(mr, ctx.deployment) && !!mr.source_branch && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const { login } = ctx.deployment.gitlab!
    return `MR does not belong to this ticket: use the source MR or an MR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mrsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:mr:${mr.iid}`)
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles a polled MR's opened/merged/closed state with any bound or branch-matching ticket.
 * An open agent MR auto-binds to the single open ticket on its branch unless that ticket already follows another open MR.
 * @returns whether the MR has ended.
 */
export async function observeMr(ctx: SourceContext, mr: Mr): Promise<boolean> {
  const ended = mr.state === 'closed' || mr.state === 'merged' || !!mr.merged
  if (!ended) {
    const candidates = agentMr(mr, ctx.deployment) && mr.source_branch
      ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch!)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // An MR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:mr:${mr.iid}` && item.closed)
    if (ticket && (reopened || mrsOf(ticket, true).every(iid => iid === mr.iid))) claimMr(ctx, ticket.id, mr)
  }
  if (ended) closeMr(ctx, mr)
  return ended
}
function bind(ctx: SourceContext, ticketId: string, mr: Mr, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: `mr:${mr.iid}` }, own)
    ctx.threads.patch(`${SOURCE}:mr:${mr.iid}`, { iid: mr.iid, isMr: true, url: mr.web_url, mrAuthor: mr.author.username ?? '' })
  })
}
/**
 * Reports a merged or closed MR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the MR stays so a later human comment there resumes the ticket.
 */
function closeMr(ctx: SourceContext, mr: Mr): void {
  if (!ctx.tickets.open().some(ticket => mrsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: `mr:${mr.iid}` }, mr.merged || mr.state === 'merged' ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its MR (selecting the last-closed MR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function mrEndNotices(ticket: Ticket, request: string, links: { host: string; repository: string }): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrIid(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = mrIid(follow.thread)!
  const url = `https://${links.host}/${links.repository}/-/merge_requests/${iid}`
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  // GitLab timelines already show the merge or closure, so GitLab channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
