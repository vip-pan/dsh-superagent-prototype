/** POPO background loop: windowed message_search polling of all the account's sessions, newest page first. */
import { threadKey, type Trigger } from '../core/index.ts'
import { validItems } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import { pollFailure } from './github.ts'
import { MessageRowSchema, popoTrigger, SearchPageSchema, SOURCE, toolData, type MessageRow } from './popo-trigger.ts'
import type { PopoConfig } from './popo.ts'

/** The KV cursor of the global ingest window; per-thread seen lists deduplicate the deliberate overlap. */
const CURSOR = '__cursor__'
/** Search results can lag message arrival by seconds; the window re-reads the last minute and dedup filters it. */
const OVERLAP_MS = 60_000
/** Server-side index lag is absorbed by rewinding the cursor; never let it stall progress. */
const CURSOR_LAG_MS = 30_000
const SEEN_LIMIT = 200
const PAGES = 10
/** A single failed search stays quiet; three consecutive failures report, matching the GitHub Source's default. */
const FAILURES_BEFORE_ERROR = 3

const settings = (ctx: SourceContext): PopoConfig | undefined => ctx.config<PopoConfig>(SOURCE)

/** True when the session's messages pass the Source's receive switches; the Policy's admission still applies downstream. */
function listened(row: MessageRow, config: PopoConfig): boolean {
  if (row.sessionType !== 3) return config.directMessages
  return config.chats.some(chat => chat.chatId === row.session_id) || config.otherChats === 'mentions'
}

/** True when `id` is new for the thread; remembers it and trims the remembered ids to `SEEN_LIMIT`. */
function seen(ctx: SourceContext, thread: string, id: string): boolean {
  const remembered = ctx.state.get(KV.popo.seen(thread)) ?? []
  if (remembered.includes(id)) return false
  ctx.state.set(KV.popo.seen(thread), [...remembered, id].slice(-SEEN_LIMIT))
  return true
}

async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  for (const ref of trigger.threads) {
    const session = String(trigger.meta.session ?? '')
    const name = trigger.meta.sessionName ? String(trigger.meta.sessionName) : session
    const chat = trigger.meta.sessionType === 'group'
      ? { value: name } : { value: { zh: '私聊', en: 'Direct message' } }
    ctx.threads.describe(threadKey(ref), { facts: { chat } })
    const sessions = ctx.state.get(KV.popo.sessions) ?? {}
    ctx.state.set(KV.popo.sessions, { ...sessions, [session]: true })
  }
}

/** Reads every new message of the window, in every session the account can search, and receives the listened ones. */
async function pollWindow(ctx: SourceContext, signal: AbortSignal): Promise<{ count: number }> {
  const config = settings(ctx)!
  const account = ctx.deployment.popo?.uid ?? ''
  const commands = ctx.commands.withSignal(signal)
  const now = Date.now()
  const previous = ctx.state.get(KV.popo.history(CURSOR))
  if (!previous) { ctx.state.set(KV.popo.history(CURSOR), new Date(now).toISOString()); return { count: 0 } }
  const start = Math.max(Date.parse(previous) - OVERLAP_MS, now - 24 * 3600_000)
  const rows: MessageRow[] = []
  for (let page = 0; page < PAGES; page++) {
    const args = ['message_search', 'type=1', `page=${page}`, 'pageSize=50', 'msgType=0', `timeStart=${start}`, `timeEnd=${now + 1000}`]
    const payload = toolData<Record<string, unknown>>(await commands.popo(args), 'result_list')
    const result = SearchPageSchema.parse(payload)
    rows.push(...validItems(MessageRowSchema, result.result_list ?? []))
    if (result.has_more !== true && result.has_more !== 1) break
  }
  let count = 0
  for (const row of rows) {
    const trigger = popoTrigger(row, account)
    if (!trigger || !listened(row, config)) continue
    const thread = trigger.threads[0]!.id
    if (!seen(ctx, thread, trigger.meta.messageId as string)) continue
    await receive(ctx, trigger)
    count++
  }
  const advanced = new Date(Math.max(Date.parse(previous), now - CURSOR_LAG_MS)).toISOString()
  ctx.state.set(KV.popo.history(CURSOR), advanced)
  return { count }
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = settings(ctx)
    try {
      if (config) {
        const { count } = await pollWindow(ctx, signal)
        if (!signal.aborted) ctx.report(SOURCE, { state: 'ready', detail: `${count} messages; next poll ≥ ${config.pollSeconds}s`, at: new Date().toISOString() })
      } else ctx.report(SOURCE, health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, FAILURES_BEFORE_ERROR, error)
      if (!signal.aborted && failed) ctx.report(SOURCE, failed)
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}

/** Runs the POPO polling loop until `signal` aborts; `apply` contains an escaping failure as source health. */
export function runPopo(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  return watch(ctx, signal)
}
